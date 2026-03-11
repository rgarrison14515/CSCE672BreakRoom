import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

type PublicUser = {
  userId: string;
  displayName: string;
  presence: "in_lobby" | "in_session";
};

type UserRecord = PublicUser & {
  socketId: string;
};

type InviteRecord = {
  inviteId: string;
  fromUserId: string;
  toUserId: string;
  status: "pending" | "accepted" | "declined";
};

type SessionRecord = {
  sessionId: string;
  userIds: [string, string];
  activityType: "none";
  status: "active" | "ended";
};

const invitesById = new Map<string, InviteRecord>();
const usersByUserId = new Map<string, UserRecord>();
const userIdBySocketId = new Map<string, string>();
const sessionsById = new Map<string, SessionRecord>();

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});


function lobbyState(): { users: PublicUser[] } {
  return {
    users: Array.from(usersByUserId.values()).map(({ socketId, ...pub }) => pub),
  };
}

function broadcastLobby() {
  io.to("lobby").emit("LOBBY_STATE", lobbyState());
}


function findActiveSessionByUserId(userId: string): SessionRecord | undefined {
  for (const session of sessionsById.values()) {
    if (session.status === "active" && session.userIds.includes(userId)) {
      return session;
    }
  }
  return undefined;
}

io.on("connection", (socket) => {
  console.log("connected", socket.id);

  socket.on("IDENTIFY", (payload: { displayName: string }) => {
    const userId = socket.id; // v1

    const user: UserRecord = {
      userId,
      displayName: payload.displayName,
      presence: "in_lobby",
      socketId: socket.id,
    };

    usersByUserId.set(userId, user);
    userIdBySocketId.set(socket.id, userId);

    socket.emit("IDENTIFIED", { userId }); 

    console.log("IDENTIFY", socket.id, payload.displayName); // logging for dev purposes
    console.log("usersByUserId size", usersByUserId.size); // logging for dev purposes

    socket.join("lobby");
    broadcastLobby();
  });

  socket.on("INVITE_SEND", (payload: { toUserId: string }) => {
  const fromUserId = userIdBySocketId.get(socket.id);
  if (!fromUserId) return;

  const toUser = usersByUserId.get(payload.toUserId);
  if (!toUser || toUser.presence !== "in_lobby") {
    console.log("INVITE_SEND failed: target unavailable", payload.toUserId);
    return;
  }

  const inviteId = `${fromUserId}->${payload.toUserId}:${Date.now()}`;
  const invite: InviteRecord = {
    inviteId,
    fromUserId,
    toUserId: payload.toUserId,
    status: "pending",
  };

  invitesById.set(inviteId, invite);

  console.log("INVITE_SEND", invite);

  // Send invite to receiver's socket
  io.to(toUser.socketId).emit("INVITE_RECEIVED", {
    inviteId,
    fromUserId,
    fromDisplayName: usersByUserId.get(fromUserId)?.displayName ?? "Unknown",
  });
});

socket.on("INVITE_ACCEPT", (payload: { inviteId: string }) => {
  console.log("INVITE_ACCEPT received", payload, "from socket", socket.id);

  const invite = invitesById.get(payload.inviteId);
  console.log("INVITE_ACCEPT invite lookup:", invite);

  if (!invite || invite.status !== "pending") return;

  invite.status = "accepted";
  invitesById.set(invite.inviteId, invite);

  const fromUser = usersByUserId.get(invite.fromUserId);
  const toUser = usersByUserId.get(invite.toUserId);

  console.log("INVITE_ACCEPT fromUser:", fromUser);
  console.log("INVITE_ACCEPT toUser:", toUser);

  if (!fromUser || !toUser) return;

  const sessionId = `${invite.fromUserId}:${invite.toUserId}:${Date.now()}`;
  const roomName = `session:${sessionId}`;

  const session: SessionRecord = {
    sessionId,
    userIds: [invite.fromUserId, invite.toUserId],
    activityType: "none",
    status: "active",
  };

  sessionsById.set(sessionId, session);



  io.sockets.sockets.get(fromUser.socketId)?.join(roomName);
  io.sockets.sockets.get(toUser.socketId)?.join(roomName);

  io.to(fromUser.socketId).emit("INVITE_RESULT", {
    inviteId: invite.inviteId,
    result: "success",
  });

  fromUser.presence = "in_session";
  toUser.presence = "in_session";

  io.to(fromUser.socketId).emit("SESSION_STARTED", {
    sessionId,
    peerUserId: toUser.userId,
    peerDisplayName: toUser.displayName,
    activityType: "none",
  });

  io.to(toUser.socketId).emit("SESSION_STARTED", {
    sessionId,
    peerUserId: fromUser.userId,
    peerDisplayName: fromUser.displayName,
    activityType: "none",
  });

  broadcastLobby();

  console.log("SESSION_STARTED", session);
});

  socket.on("INVITE_DECLINE", (payload: { inviteId: string }) => {
    console.log("INVITE_DECLINE received", payload, "from socket", socket.id);

    const invite = invitesById.get(payload.inviteId);
    console.log("INVITE_DECLINE invite lookup:", invite);

    if (!invite || invite.status !== "pending") return;

    invite.status = "declined";
    invitesById.set(invite.inviteId, invite);

    const fromUser = usersByUserId.get(invite.fromUserId);
    console.log("INVITE_DECLINE fromUser:", fromUser);

    if (fromUser) {
      io.to(fromUser.socketId).emit("INVITE_RESULT", { inviteId: invite.inviteId, result: "failed" });
      console.log("INVITE_RESULT emitted to", fromUser.socketId);
    }
  });

  socket.on("disconnect", () => {
    const userId = userIdBySocketId.get(socket.id);

    console.log("disconnect", socket.id, "userId:", userId);

    if (!userId) {
      broadcastLobby();
      return;
    }

    const activeSession = findActiveSessionByUserId(userId);

    if (activeSession) {
      console.log("disconnect ended active session", activeSession.sessionId);

      activeSession.status = "ended";
      sessionsById.set(activeSession.sessionId, activeSession);

      const [userAId, userBId] = activeSession.userIds;
      const otherUserId = userAId === userId ? userBId : userAId;
      const otherUser = usersByUserId.get(otherUserId);

      const roomName = `session:${activeSession.sessionId}`;

      // Remove disconnected user from tracking
      usersByUserId.delete(userId);
      userIdBySocketId.delete(socket.id);

      // Notify and restore the other user
      if (otherUser) {
        otherUser.presence = "in_lobby";
        io.sockets.sockets.get(otherUser.socketId)?.leave(roomName);
        io.to(otherUser.socketId).emit("SESSION_ENDED", {
          sessionId: activeSession.sessionId,
        });
      }

      console.log("SESSION_ENDED due to disconnect", activeSession.sessionId);

      sessionsById.delete(activeSession.sessionId);
      broadcastLobby();
      return;
    }

    usersByUserId.delete(userId);
    userIdBySocketId.delete(socket.id);
    broadcastLobby();
  });

  socket.on("SESSION_LEAVE", (payload: { sessionId: string }) => {
    console.log("SESSION_LEAVE received", payload, "from socket", socket.id);

    const session = sessionsById.get(payload.sessionId);
    console.log("SESSION_LEAVE session lookup:", session);

    if (!session || session.status !== "active") return;

    session.status = "ended";
    sessionsById.set(session.sessionId, session);

    const [userAId, userBId] = session.userIds;
    const userA = usersByUserId.get(userAId);
    const userB = usersByUserId.get(userBId);

    const roomName = `session:${session.sessionId}`;

    if (userA) {
      io.sockets.sockets.get(userA.socketId)?.leave(roomName);
      io.to(userA.socketId).emit("SESSION_ENDED", {
        sessionId: session.sessionId,
      });
    }

    if (userB) {
      io.sockets.sockets.get(userB.socketId)?.leave(roomName);
      io.to(userB.socketId).emit("SESSION_ENDED", {
        sessionId: session.sessionId,
      });
    }

    // mark both users back to in_lobby at end of session
    if (userA) {
      userA.presence = "in_lobby";
    }

    if (userB) {
      userB.presence = "in_lobby";
    }

    console.log("SESSION_ENDED", session.sessionId);

    broadcastLobby();

    sessionsById.delete(session.sessionId);
  });
});

server.listen(3001, () => {
  console.log("server listening on http://localhost:3001");
});