import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

type PublicUser = {
  userId: string;
  displayName: string;
  presence: "in_lobby";
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
  status: "active";
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
  if (!toUser) {
    console.log("INVITE_SEND failed: target not found", payload.toUserId);
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

   console.log("disconnect", socket.id, "userId:", userId); // logging for dev purposes

    if (userId) {
      usersByUserId.delete(userId);
      userIdBySocketId.delete(socket.id);
    }
    broadcastLobby();
  });
});

server.listen(3001, () => {
  console.log("server listening on http://localhost:3001");
});