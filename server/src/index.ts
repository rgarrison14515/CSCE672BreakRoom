import express, { Request, Response } from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { Chess } from "chess.js";

// ── Slack config ────────────────────────────────────────────────────────────
import "dotenv/config";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const CLIENT_URL = process.env.CLIENT_URL ?? "http://localhost:5173";

// ── Types ────────────────────────────────────────────────────────────────────
type PublicUser = {
  userId: string;
  displayName: string;
  presence: "in_lobby" | "in_session";
};

type UserRecord = PublicUser & {
  socketId: string;
};

type ActivityType = "chess" | "connect4";

type InviteRecord = {
  inviteId: string;
  fromUserId: string;
  toUserId: string;
  activityType: ActivityType;
  status: "pending" | "accepted" | "declined" | "expired";
};

type ChatMessage = {
  senderUserId: string;
  senderDisplayName: string;
  text: string;
};

type C4Color = null | "r" | "y";

type SessionRecord = {
  sessionId: string;
  userIds: [string, string];
  activityType: ActivityType;
  status: "active" | "ended";
  chessFen: string;
  turn: "w" | "b";
  chatMessages: ChatMessage[];
  c4Board: C4Color[][];
  c4Turn: "r" | "y";
  c4Winner: null | "r" | "y" | "draw";
};

// Slack invite links: token -> { activityType, fromDisplayName, expires }
type SlackInviteLink = {
  activityType: ActivityType;
  fromDisplayName: string;
  expires: number;
};

// ── In-memory state ──────────────────────────────────────────────────────────
const invitesById = new Map<string, InviteRecord>();
const usersByUserId = new Map<string, UserRecord>();
const userIdBySocketId = new Map<string, string>();
const sessionsById = new Map<string, SessionRecord>();
const slackInviteLinks = new Map<string, SlackInviteLink>();

// ── Express + Socket.IO setup ────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function makeC4Board(): C4Color[][] {
  return Array.from({ length: 6 }, () => Array(7).fill(null));
}

function checkC4Winner(board: C4Color[][]): null | "r" | "y" | "draw" {
  const rows = 6, cols = 7;
  const directions = [[0,1],[1,0],[1,1],[1,-1]];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (!cell) continue;
      for (const [dr, dc] of directions) {
        let count = 1;
        for (let i = 1; i < 4; i++) {
          const nr = r + dr! * i, nc = c + dc! * i;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols || board[nr][nc] !== cell) break;
          count++;
        }
        if (count === 4) return cell;
      }
    }
  }
  if (board[0].every(cell => cell !== null)) return "draw";
  return null;
}

function lobbyState(): { users: PublicUser[] } {
  return {
    users: Array.from(usersByUserId.values()).map(({ socketId, ...pub }) => pub),
  };
}

function broadcastLobby() {
  io.to("lobby").emit("LOBBY_STATE", lobbyState());
}

function emitChatState(session: SessionRecord) {
  const roomName = `session:${session.sessionId}`;
  io.to(roomName).emit("CHAT_STATE", {
    sessionId: session.sessionId,
    messages: session.chatMessages,
  });
}

function emitC4State(session: SessionRecord) {
  const roomName = `session:${session.sessionId}`;
  io.to(roomName).emit("C4_STATE", {
    sessionId: session.sessionId,
    board: session.c4Board,
    turn: session.c4Turn,
    winner: session.c4Winner,
  });
}

function findActiveSessionByUserId(userId: string): SessionRecord | undefined {
  for (const session of sessionsById.values()) {
    if (session.status === "active" && session.userIds.includes(userId)) {
      return session;
    }
  }
  return undefined;
}

// ── Slack helpers ────────────────────────────────────────────────────────────

// Look up a Slack user's ID by their display name or email
async function findSlackUserId(nameOrEmail: string): Promise<string | null> {
  // Try by email first
  if (nameOrEmail.includes("@")) {
    const res = await fetch(
      `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(nameOrEmail)}`,
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
    );
    const data = await res.json() as any;
    if (data.ok) return data.user.id;
  }

  // Otherwise search display name in users.list
  const res = await fetch("https://slack.com/api/users.list", {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const data = await res.json() as any;
  if (!data.ok) return null;

  const match = data.members.find((m: any) =>
    m.profile?.display_name?.toLowerCase() === nameOrEmail.toLowerCase() ||
    m.name?.toLowerCase() === nameOrEmail.toLowerCase() ||
    m.real_name?.toLowerCase() === nameOrEmail.toLowerCase()
  );
  return match?.id ?? null;
}

async function sendSlackDM(slackUserId: string, text: string, blocks?: object[]): Promise<boolean> {
  // Open a DM channel
  const openRes = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ users: slackUserId }),
  });
  const openData = await openRes.json() as any;
  if (!openData.ok) {
    console.error("conversations.open failed", openData.error);
    return false;
  }

  const channelId = openData.channel.id;

  // Post message
  const msgRes = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId, text, blocks }),
  });
  const msgData = await msgRes.json() as any;
  if (!msgData.ok) {
    console.error("chat.postMessage failed", msgData.error);
    return false;
  }

  return true;
}

// ── HTTP REST endpoints ──────────────────────────────────────────────────────

// POST /slack/invite  — send a Slack DM invite
app.post("/slack/invite", async (req: Request, res: Response) => {
  const { slackUsername, activityType, fromDisplayName } = req.body as {
    slackUsername: string;
    activityType: ActivityType;
    fromDisplayName: string;
  };

  if (!slackUsername || !activityType || !fromDisplayName) {
    res.status(400).json({ ok: false, error: "Missing fields" });
    return;
  }

  // Find Slack user
  const slackUserId = await findSlackUserId(slackUsername);
  if (!slackUserId) {
    res.status(404).json({ ok: false, error: "Slack user not found" });
    return;
  }

  // Generate a unique join token
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  slackInviteLinks.set(token, {
    activityType,
    fromDisplayName,
    expires: Date.now() + 10 * 60 * 1000, // 10 minutes
  });

  const joinUrl = `${CLIENT_URL}?slackInvite=${token}&from=${encodeURIComponent(fromDisplayName)}`;
  const gameLabel = activityType === "chess" ? "Chess ♟️" : "Connect 4 🔴";

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${fromDisplayName}* is inviting you to play *${gameLabel}* on Breakroom!`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Join Game 🎮" },
          style: "primary",
          url: joinUrl,
        },
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `This invite expires in 10 minutes.` }],
    },
  ];

  const ok = await sendSlackDM(slackUserId, `${fromDisplayName} invited you to play ${gameLabel} on Breakroom! ${joinUrl}`, blocks);

  if (ok) {
    res.json({ ok: true, token });
  } else {
    res.status(500).json({ ok: false, error: "Failed to send Slack message" });
  }
});

// GET /slack/invite/:token — validate a join link token
app.get("/slack/invite/:token", (req: Request, res: Response) => {
  const link = slackInviteLinks.get(req.params.token);
  if (!link) {
    res.status(404).json({ ok: false, error: "Invalid or expired invite" });
    return;
  }
  if (Date.now() > link.expires) {
    slackInviteLinks.delete(req.params.token);
    res.status(410).json({ ok: false, error: "Invite expired" });
    return;
  }
  res.json({ ok: true, activityType: link.activityType, fromDisplayName: link.fromDisplayName });
});

// ── Socket.IO ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("connected", socket.id);

  socket.on("IDENTIFY", (payload: { displayName: string }) => {
    const userId = socket.id;
    const user: UserRecord = {
      userId,
      displayName: payload.displayName,
      presence: "in_lobby",
      socketId: socket.id,
    };
    usersByUserId.set(userId, user);
    userIdBySocketId.set(socket.id, userId);
    socket.emit("IDENTIFIED", { userId });
    console.log("IDENTIFY", socket.id, payload.displayName);
    socket.join("lobby");
    broadcastLobby();
  });

  socket.on("INVITE_SEND", (payload: { toUserId: string; activityType: ActivityType }) => {
    const fromUserId = userIdBySocketId.get(socket.id);
    if (!fromUserId) return;

    const toUser = usersByUserId.get(payload.toUserId);
    if (!toUser || toUser.presence !== "in_lobby") return;

    const inviteId = `${fromUserId}->${payload.toUserId}:${Date.now()}`;
    const invite: InviteRecord = {
      inviteId,
      fromUserId,
      toUserId: payload.toUserId,
      activityType: payload.activityType,
      status: "pending",
    };
    invitesById.set(inviteId, invite);

    setTimeout(() => {
      const currentInvite = invitesById.get(inviteId);
      if (!currentInvite || (currentInvite.status !== "pending" && currentInvite.status !== "declined")) return;
      const wasPending = currentInvite.status === "pending";
      currentInvite.status = "expired";
      invitesById.set(inviteId, currentInvite);
      const fromUser = usersByUserId.get(currentInvite.fromUserId);
      if (fromUser) io.to(fromUser.socketId).emit("INVITE_RESULT", { inviteId, result: "failed" });
      if (wasPending) {
        const toUser = usersByUserId.get(currentInvite.toUserId);
        if (toUser) {
          io.to(toUser.socketId).emit("INVITE_EXPIRED", {
            inviteId,
            fromDisplayName: usersByUserId.get(currentInvite.fromUserId)?.displayName ?? "Unknown",
            activityType: currentInvite.activityType,
          });
        }
      }
    }, 15000);

    io.to(toUser.socketId).emit("INVITE_RECEIVED", {
      inviteId,
      fromUserId,
      fromDisplayName: usersByUserId.get(fromUserId)?.displayName ?? "Unknown",
      activityType: invite.activityType,
    });
  });

  socket.on("INVITE_ACCEPT", (payload: { inviteId: string }) => {
    const invite = invitesById.get(payload.inviteId);
    if (!invite || invite.status !== "pending") return;

    invite.status = "accepted";
    invitesById.set(invite.inviteId, invite);

    const fromUser = usersByUserId.get(invite.fromUserId);
    const toUser = usersByUserId.get(invite.toUserId);
    if (!fromUser || !toUser) return;

    const sessionId = `${invite.fromUserId}:${invite.toUserId}:${Date.now()}`;
    const roomName = `session:${sessionId}`;
    const initialGame = new Chess();

    const session: SessionRecord = {
      sessionId,
      userIds: [invite.fromUserId, invite.toUserId],
      activityType: invite.activityType,
      status: "active",
      chessFen: initialGame.fen(),
      turn: initialGame.turn(),
      chatMessages: [],
      c4Board: makeC4Board(),
      c4Turn: "r",
      c4Winner: null,
    };
    sessionsById.set(sessionId, session);

    io.sockets.sockets.get(fromUser.socketId)?.join(roomName);
    io.sockets.sockets.get(toUser.socketId)?.join(roomName);

    io.to(fromUser.socketId).emit("INVITE_RESULT", { inviteId: invite.inviteId, result: "success" });
    fromUser.presence = "in_session";
    toUser.presence = "in_session";

    io.to(fromUser.socketId).emit("SESSION_STARTED", {
      sessionId, peerUserId: toUser.userId, peerDisplayName: toUser.displayName,
      activityType: invite.activityType, playerColor: "w",
    });
    io.to(toUser.socketId).emit("SESSION_STARTED", {
      sessionId, peerUserId: fromUser.userId, peerDisplayName: fromUser.displayName,
      activityType: invite.activityType, playerColor: "b",
    });

    if (session.activityType === "chess") {
      io.to(roomName).emit("CHESS_STATE", { sessionId, fen: session.chessFen, turn: session.turn });
    } else if (session.activityType === "connect4") {
      emitC4State(session);
    }

    emitChatState(session);
    broadcastLobby();
    console.log("SESSION_STARTED", session);
  });

  socket.on("INVITE_DECLINE", (payload: { inviteId: string }) => {
    const invite = invitesById.get(payload.inviteId);
    if (!invite || invite.status !== "pending") return;
    invite.status = "declined";
    invitesById.set(invite.inviteId, invite);
  });

  socket.on("CHESS_MOVE", (payload: { sessionId: string; from: string; to: string; promotion?: "q" | "r" | "b" | "n" }) => {
    const userId = userIdBySocketId.get(socket.id);
    if (!userId) return;
    const session = sessionsById.get(payload.sessionId);
    if (!session || session.status !== "active") return;
    if (!session.userIds.includes(userId)) return;

    const game = new Chess(session.chessFen);
    const expectedUserId = game.turn() === "w" ? session.userIds[0] : session.userIds[1];
    if (userId !== expectedUserId) return;

    try {
      game.move({ from: payload.from, to: payload.to, promotion: payload.promotion ?? "q" });
    } catch {
      return;
    }

    session.chessFen = game.fen();
    session.turn = game.turn();
    sessionsById.set(session.sessionId, session);

    io.to(`session:${session.sessionId}`).emit("CHESS_STATE", {
      sessionId: session.sessionId, fen: session.chessFen, turn: session.turn,
    });
  });

  socket.on("C4_DROP", (payload: { sessionId: string; col: number }) => {
    const userId = userIdBySocketId.get(socket.id);
    if (!userId) return;
    const session = sessionsById.get(payload.sessionId);
    if (!session || session.status !== "active" || session.activityType !== "connect4") return;
    if (!session.userIds.includes(userId)) return;
    if (session.c4Winner) return;

    const myColor: "r" | "y" = session.userIds[0] === userId ? "r" : "y";
    if (myColor !== session.c4Turn) return;

    const board = session.c4Board;
    const col = payload.col;
    if (col < 0 || col > 6) return;

    let dropRow = -1;
    for (let r = 5; r >= 0; r--) {
      if (board[r][col] === null) { dropRow = r; break; }
    }
    if (dropRow === -1) return;

    board[dropRow][col] = myColor;
    session.c4Turn = myColor === "r" ? "y" : "r";
    session.c4Winner = checkC4Winner(board);
    sessionsById.set(session.sessionId, session);
    emitC4State(session);
  });

  socket.on("C4_REMATCH", (payload: { sessionId: string }) => {
    const session = sessionsById.get(payload.sessionId);
    if (!session || session.activityType !== "connect4") return;
    session.c4Board = makeC4Board();
    session.c4Turn = "r";
    session.c4Winner = null;
    session.status = "active";
    sessionsById.set(session.sessionId, session);
    emitC4State(session);
  });

  socket.on("CHAT_SEND", (payload: { sessionId: string; text: string }) => {
    const userId = userIdBySocketId.get(socket.id);
    if (!userId) return;
    const session = sessionsById.get(payload.sessionId);
    if (!session || session.status !== "active") return;
    if (!session.userIds.includes(userId)) return;
    const user = usersByUserId.get(userId);
    if (!user) return;
    const text = payload.text.trim();
    if (!text) return;
    session.chatMessages.push({ senderUserId: user.userId, senderDisplayName: user.displayName, text });
    sessionsById.set(session.sessionId, session);
    emitChatState(session);
  });

  socket.on("disconnect", () => {
    const userId = userIdBySocketId.get(socket.id);
    if (!userId) { broadcastLobby(); return; }

    const activeSession = findActiveSessionByUserId(userId);
    if (activeSession) {
      activeSession.status = "ended";
      sessionsById.set(activeSession.sessionId, activeSession);
      const [userAId, userBId] = activeSession.userIds;
      const otherUserId = userAId === userId ? userBId : userAId;
      const otherUser = usersByUserId.get(otherUserId);
      const roomName = `session:${activeSession.sessionId}`;
      usersByUserId.delete(userId);
      userIdBySocketId.delete(socket.id);
      if (otherUser) {
        otherUser.presence = "in_lobby";
        io.sockets.sockets.get(otherUser.socketId)?.leave(roomName);
        io.to(otherUser.socketId).emit("SESSION_ENDED", { sessionId: activeSession.sessionId });
      }
      sessionsById.delete(activeSession.sessionId);
      broadcastLobby();
      return;
    }

    usersByUserId.delete(userId);
    userIdBySocketId.delete(socket.id);
    broadcastLobby();
  });

  socket.on("SESSION_LEAVE", (payload: { sessionId: string }) => {
    const session = sessionsById.get(payload.sessionId);
    if (!session || session.status !== "active") return;
    session.status = "ended";
    sessionsById.set(session.sessionId, session);

    const [userAId, userBId] = session.userIds;
    const userA = usersByUserId.get(userAId);
    const userB = usersByUserId.get(userBId);
    const roomName = `session:${session.sessionId}`;

    if (userA) { io.sockets.sockets.get(userA.socketId)?.leave(roomName); io.to(userA.socketId).emit("SESSION_ENDED", { sessionId: session.sessionId }); }
    if (userB) { io.sockets.sockets.get(userB.socketId)?.leave(roomName); io.to(userB.socketId).emit("SESSION_ENDED", { sessionId: session.sessionId }); }
    if (userA) userA.presence = "in_lobby";
    if (userB) userB.presence = "in_lobby";

    broadcastLobby();
    sessionsById.delete(session.sessionId);
  });
});

server.listen(3001, () => {
  console.log("server listening on http://localhost:3001");
});
