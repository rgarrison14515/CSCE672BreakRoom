import express, { Request, Response } from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { Chess } from "chess.js";

// ── Slack config ─────────────────────────────────────────────────────────────
import "dotenv/config";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? "";
const CLIENT_URL = process.env.CLIENT_URL ?? "http://localhost:5173";

// ── Types ─────────────────────────────────────────────────────────────────────
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

// A Slack invite link — now includes the inviter's userId so we can
// auto-start the session the moment the recipient connects.
type SlackInviteLink = {
  activityType: ActivityType;
  fromDisplayName: string;
  fromUserId: string;       // socket/userId of the waiting inviter
  expires: number;
};

// ── In-memory state ───────────────────────────────────────────────────────────
const invitesById     = new Map<string, InviteRecord>();
const usersByUserId   = new Map<string, UserRecord>();
const userIdBySocketId = new Map<string, string>();
const sessionsById    = new Map<string, SessionRecord>();
const slackInviteLinks = new Map<string, SlackInviteLink>();

// ── Express + Socket.IO ───────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: CLIENT_URL, methods: ["GET", "POST"] },
});

// ── Game helpers ──────────────────────────────────────────────────────────────
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
  if (board[0].every(c => c !== null)) return "draw";
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
  io.to(`session:${session.sessionId}`).emit("CHAT_STATE", {
    sessionId: session.sessionId,
    messages: session.chatMessages,
  });
}

function emitC4State(session: SessionRecord) {
  io.to(`session:${session.sessionId}`).emit("C4_STATE", {
    sessionId: session.sessionId,
    board: session.c4Board,
    turn: session.c4Turn,
    winner: session.c4Winner,
  });
}

function findActiveSessionByUserId(userId: string): SessionRecord | undefined {
  for (const session of sessionsById.values()) {
    if (session.status === "active" && session.userIds.includes(userId)) return session;
  }
}

// ── Start a session between two already-registered users ─────────────────────
function startSession(
  fromUser: UserRecord,
  toUser: UserRecord,
  activityType: ActivityType
) {
  const sessionId = `${fromUser.userId}:${toUser.userId}:${Date.now()}`;
  const roomName  = `session:${sessionId}`;
  const initialGame = new Chess();

  const session: SessionRecord = {
    sessionId,
    userIds: [fromUser.userId, toUser.userId],
    activityType,
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

  fromUser.presence = "in_session";
  toUser.presence   = "in_session";

  io.to(fromUser.socketId).emit("SESSION_STARTED", {
    sessionId,
    peerUserId: toUser.userId,
    peerDisplayName: toUser.displayName,
    activityType,
    playerColor: "w",
  });
  io.to(toUser.socketId).emit("SESSION_STARTED", {
    sessionId,
    peerUserId: fromUser.userId,
    peerDisplayName: fromUser.displayName,
    activityType,
    playerColor: "b",
  });

  if (activityType === "chess") {
    io.to(roomName).emit("CHESS_STATE", { sessionId, fen: session.chessFen, turn: session.turn });
  } else {
    emitC4State(session);
  }

  emitChatState(session);
  broadcastLobby();
  console.log("SESSION_STARTED", sessionId);
}

// ── Slack helpers ─────────────────────────────────────────────────────────────
async function findSlackUserId(nameOrEmail: string): Promise<string | null> {
  if (nameOrEmail.includes("@")) {
    const res  = await fetch(
      `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(nameOrEmail)}`,
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
    );
    const data = await res.json() as any;
    if (data.ok) return data.user.id;
  }

  const res  = await fetch("https://slack.com/api/users.list", {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const data = await res.json() as any;
  if (!data.ok) return null;

  const match = data.members.find((m: any) =>
    m.profile?.display_name?.toLowerCase() === nameOrEmail.toLowerCase() ||
    m.name?.toLowerCase()                  === nameOrEmail.toLowerCase() ||
    m.real_name?.toLowerCase()             === nameOrEmail.toLowerCase()
  );
  return match?.id ?? null;
}

async function sendSlackDM(slackUserId: string, text: string, blocks?: object[]): Promise<boolean> {
  const openRes  = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ users: slackUserId }),
  });
  const openData = await openRes.json() as any;
  if (!openData.ok) { console.error("conversations.open failed", openData.error); return false; }

  const msgRes  = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: openData.channel.id, text, blocks }),
  });
  const msgData = await msgRes.json() as any;
  if (!msgData.ok) { console.error("chat.postMessage failed", msgData.error); return false; }
  return true;
}

// ── HTTP endpoints ────────────────────────────────────────────────────────────

// POST /slack/invite — send a Slack DM and store the pending link
app.post("/slack/invite", async (req: Request, res: Response) => {
  const { slackUsername, activityType, fromDisplayName, fromUserId } = req.body as {
    slackUsername: string;
    activityType: ActivityType;
    fromDisplayName: string;
    fromUserId: string;
  };

  if (!slackUsername || !activityType || !fromDisplayName || !fromUserId) {
    res.status(400).json({ ok: false, error: "Missing fields" });
    return;
  }

  const slackUserId = await findSlackUserId(slackUsername);
  if (!slackUserId) {
    res.status(404).json({ ok: false, error: "Slack user not found" });
    return;
  }

  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  slackInviteLinks.set(token, {
    activityType,
    fromDisplayName,
    fromUserId,           // store inviter's userId
    expires: Date.now() + 10 * 60 * 1000,
  });

  const joinUrl   = `${CLIENT_URL}?slackInvite=${token}&from=${encodeURIComponent(fromDisplayName)}`;
  const gameLabel = activityType === "chess" ? "Chess ♟️" : "Connect 4 🔴";

  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${fromDisplayName}* is inviting you to play *${gameLabel}* on Breakroom!` },
    },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Join Game 🎮" }, style: "primary", url: joinUrl },
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "This invite expires in 10 minutes. You'll be dropped straight into the game!" }],
    },
  ];

  const ok = await sendSlackDM(
    slackUserId,
    `${fromDisplayName} invited you to play ${gameLabel} on Breakroom! ${joinUrl}`,
    blocks
  );

  if (ok) res.json({ ok: true, token });
  else    res.status(500).json({ ok: false, error: "Failed to send Slack message" });
});

// GET /slack/invite/:token — validate token; client calls this on page load
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
  res.json({
    ok: true,
    activityType: link.activityType,
    fromDisplayName: link.fromDisplayName,
    fromUserId: link.fromUserId,
  });
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("connected", socket.id);

  socket.on("IDENTIFY", (payload: { displayName: string; slackInviteToken?: string }) => {
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
    socket.join("lobby");
    broadcastLobby();

    // ── Auto-start session if joining via Slack invite link ───────────────
    if (payload.slackInviteToken) {
      const link = slackInviteLinks.get(payload.slackInviteToken);
      if (link && Date.now() <= link.expires) {
        const fromUser = usersByUserId.get(link.fromUserId);
        if (fromUser && fromUser.presence === "in_lobby") {
          slackInviteLinks.delete(payload.slackInviteToken);
          // Small delay so the joining client finishes its IDENTIFIED handler first
          setTimeout(() => startSession(fromUser, user, link.activityType), 100);
          return;
        } else {
          // Inviter is gone or busy — let the recipient know
          socket.emit("SLACK_INVITE_UNAVAILABLE", {
            fromDisplayName: link.fromDisplayName,
          });
        }
      } else {
        socket.emit("SLACK_INVITE_UNAVAILABLE", { fromDisplayName: "" });
      }
    }

    console.log("IDENTIFY", socket.id, payload.displayName);
  });

  socket.on("INVITE_SEND", (payload: { toUserId: string; activityType: ActivityType }) => {
    const fromUserId = userIdBySocketId.get(socket.id);
    if (!fromUserId) return;
    const toUser = usersByUserId.get(payload.toUserId);
    if (!toUser || toUser.presence !== "in_lobby") return;

    const inviteId = `${fromUserId}->${payload.toUserId}:${Date.now()}`;
    const invite: InviteRecord = {
      inviteId, fromUserId, toUserId: payload.toUserId,
      activityType: payload.activityType, status: "pending",
    };
    invitesById.set(inviteId, invite);

    setTimeout(() => {
      const cur = invitesById.get(inviteId);
      if (!cur || (cur.status !== "pending" && cur.status !== "declined")) return;
      const wasPending = cur.status === "pending";
      cur.status = "expired";
      invitesById.set(inviteId, cur);
      const fromUser = usersByUserId.get(cur.fromUserId);
      if (fromUser) io.to(fromUser.socketId).emit("INVITE_RESULT", { inviteId, result: "failed" });
      if (wasPending) {
        const toUser = usersByUserId.get(cur.toUserId);
        if (toUser) io.to(toUser.socketId).emit("INVITE_EXPIRED", {
          inviteId,
          fromDisplayName: usersByUserId.get(cur.fromUserId)?.displayName ?? "Unknown",
          activityType: cur.activityType,
        });
      }
    }, 15000);

    io.to(toUser.socketId).emit("INVITE_RECEIVED", {
      inviteId, fromUserId,
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
    const toUser   = usersByUserId.get(invite.toUserId);
    if (!fromUser || !toUser) return;

    io.to(fromUser.socketId).emit("INVITE_RESULT", { inviteId: invite.inviteId, result: "success" });
    startSession(fromUser, toUser, invite.activityType);
  });

  socket.on("INVITE_DECLINE", (payload: { inviteId: string }) => {
    const invite = invitesById.get(payload.inviteId);
    if (!invite || invite.status !== "pending") return;
    invite.status = "declined";
    invitesById.set(invite.inviteId, invite);
  });

  socket.on("CHESS_MOVE", (payload: { sessionId: string; from: string; to: string; promotion?: "q"|"r"|"b"|"n" }) => {
    const userId = userIdBySocketId.get(socket.id);
    if (!userId) return;
    const session = sessionsById.get(payload.sessionId);
    if (!session || session.status !== "active") return;
    if (!session.userIds.includes(userId)) return;

    const game = new Chess(session.chessFen);
    if (userId !== (game.turn() === "w" ? session.userIds[0] : session.userIds[1])) return;

    try { game.move({ from: payload.from, to: payload.to, promotion: payload.promotion ?? "q" }); }
    catch { return; }

    session.chessFen = game.fen();
    session.turn     = game.turn();
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
    if (!session.userIds.includes(userId) || session.c4Winner) return;

    const myColor: "r"|"y" = session.userIds[0] === userId ? "r" : "y";
    if (myColor !== session.c4Turn) return;

    const col = payload.col;
    if (col < 0 || col > 6) return;
    let dropRow = -1;
    for (let r = 5; r >= 0; r--) { if (session.c4Board[r][col] === null) { dropRow = r; break; } }
    if (dropRow === -1) return;

    session.c4Board[dropRow][col] = myColor;
    session.c4Turn   = myColor === "r" ? "y" : "r";
    session.c4Winner = checkC4Winner(session.c4Board);
    sessionsById.set(session.sessionId, session);
    emitC4State(session);
  });

  socket.on("C4_REMATCH", (payload: { sessionId: string }) => {
    const session = sessionsById.get(payload.sessionId);
    if (!session || session.activityType !== "connect4") return;
    session.c4Board  = makeC4Board();
    session.c4Turn   = "r";
    session.c4Winner = null;
    session.status   = "active";
    sessionsById.set(session.sessionId, session);
    emitC4State(session);
  });

  socket.on("CHAT_SEND", (payload: { sessionId: string; text: string }) => {
    const userId = userIdBySocketId.get(socket.id);
    if (!userId) return;
    const session = sessionsById.get(payload.sessionId);
    if (!session || session.status !== "active" || !session.userIds.includes(userId)) return;
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
      const otherUser = usersByUserId.get(userAId === userId ? userBId : userAId);
      const roomName  = `session:${activeSession.sessionId}`;
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

    [userA, userB].forEach(u => {
      if (!u) return;
      io.sockets.sockets.get(u.socketId)?.leave(roomName);
      io.to(u.socketId).emit("SESSION_ENDED", { sessionId: session.sessionId });
      u.presence = "in_lobby";
    });

    broadcastLobby();
    sessionsById.delete(session.sessionId);
  });
});

server.listen(3001, () => console.log("server listening on http://localhost:3001"));
