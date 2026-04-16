import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import ChessActivity from "./components/ChessActivity";
import Connect4Activity from "./components/Connect4Activity";

type ActivityType = "chess" | "connect4";

type PublicUser = {
  userId: string;
  displayName: string;
  presence: "in_lobby" | "in_session";
};

type ChatMessage = {
  senderUserId: string;
  senderDisplayName: string;
  text: string;
};

type C4Color = null | "r" | "y";

const SERVER = "http://localhost:3001";

export default function App() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [me, setMe] = useState("");
  const [myUserId, setMyUserId] = useState("");

  const [incomingInvite, setIncomingInvite] = useState<{
    inviteId: string; fromUserId: string; fromDisplayName: string; activityType: ActivityType;
  } | null>(null);

  const [inviteStatus, setInviteStatus] = useState("");
  const [inviteTargetUserId, setInviteTargetUserId] = useState<string | null>(null);
  const [selectedActivity, setSelectedActivity] = useState<ActivityType>("chess");
  const [expiredInviteMessage, setExpiredInviteMessage] = useState("");

  const [session, setSession] = useState<{
    sessionId: string; peerUserId: string; peerDisplayName: string;
    activityType: ActivityType; playerColor: "w" | "b";
  } | null>(null);

  const [chessState, setChessState] = useState<{ fen: string; turn: "w" | "b" } | null>(null);
  const [c4State, setC4State]       = useState<{ board: C4Color[][]; turn: "r"|"y"; winner: null|"r"|"y"|"draw" } | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput]       = useState("");

  // Slack invite UI state
  const [showSlackInvite, setShowSlackInvite] = useState(false);
  const [slackUsername, setSlackUsername]     = useState("");
  const [slackActivity, setSlackActivity]     = useState<ActivityType>("chess");
  const [slackStatus, setSlackStatus]         = useState<{ ok: boolean; msg: string } | null>(null);
  const [slackLoading, setSlackLoading]       = useState(false);

  // Holds the token from the URL if this user arrived via a Slack invite link
  const slackInviteTokenRef = useRef<string | null>(null);

  // Notification if inviter is no longer available
  const [slackUnavailable, setSlackUnavailable] = useState<string | null>(null);

  // ── Read ?slackInvite= from URL before socket connects ───────────────────
  // We capture it synchronously so it's ready when IDENTIFY fires.
  useState(() => {
    const params = new URLSearchParams(window.location.search);
    const token  = params.get("slackInvite");
    if (token) {
      slackInviteTokenRef.current = token;
      window.history.replaceState({}, "", "/");
    }
  });

  const socket: Socket = useMemo(() => io(SERVER, { transports: ["websocket"] }), []);

  // ── Socket events ─────────────────────────────────────────────────────────
  useEffect(() => {
    const name = `User-${Math.floor(Math.random() * 1000)}`;
    setMe(name);

    const onConnect = () =>
      socket.emit("IDENTIFY", {
        displayName: name,
        slackInviteToken: slackInviteTokenRef.current ?? undefined,
      });

    const onLobbyState  = (p: { users: PublicUser[] }) => setUsers(p.users);
    const onIdentified  = (p: { userId: string })      => setMyUserId(p.userId);

    const onInviteReceived = (p: { inviteId: string; fromUserId: string; fromDisplayName: string; activityType: ActivityType }) => {
      setExpiredInviteMessage(""); setIncomingInvite(p);
    };

    const onInviteResult = (p: { inviteId: string; result: "success"|"failed" }) => {
      if (p.result === "failed") setInviteStatus("Invitation failed.");
      else setInviteStatus("");
    };

    const onInviteExpired = (p: { inviteId: string; fromDisplayName: string; activityType: ActivityType }) => {
      setExpiredInviteMessage(`Invite from ${p.fromDisplayName} for ${p.activityType} expired.`);
      setIncomingInvite(null);
    };

    const onSessionStarted = (p: { sessionId: string; peerUserId: string; peerDisplayName: string; activityType: ActivityType; playerColor: "w"|"b" }) => {
      setInviteStatus(""); setSession(p);
    };

    const onSessionEnded = (_p: { sessionId: string }) => {
      setSession(null); setChessState(null); setC4State(null);
      setInviteStatus(""); setChatMessages([]); setChatInput("");
    };

    const onChessState = (p: { sessionId: string; fen: string; turn: "w"|"b" }) =>
      setChessState({ fen: p.fen, turn: p.turn });

    const onC4State = (p: { sessionId: string; board: C4Color[][]; turn: "r"|"y"; winner: null|"r"|"y"|"draw" }) =>
      setC4State({ board: p.board, turn: p.turn, winner: p.winner });

    const onChatState = (p: { sessionId: string; messages: ChatMessage[] }) =>
      setChatMessages(p.messages);

    // Inviter was unavailable when recipient connected via Slack link
    const onSlackUnavailable = (p: { fromDisplayName: string }) => {
      setSlackUnavailable(
        p.fromDisplayName
          ? `${p.fromDisplayName} is no longer available. You can still use the lobby to play with others.`
          : "This invite link has expired or the host is unavailable."
      );
    };

    socket.on("connect",                onConnect);
    socket.on("LOBBY_STATE",            onLobbyState);
    socket.on("IDENTIFIED",             onIdentified);
    socket.on("INVITE_RECEIVED",        onInviteReceived);
    socket.on("INVITE_RESULT",          onInviteResult);
    socket.on("INVITE_EXPIRED",         onInviteExpired);
    socket.on("SESSION_STARTED",        onSessionStarted);
    socket.on("CHESS_STATE",            onChessState);
    socket.on("C4_STATE",               onC4State);
    socket.on("CHAT_STATE",             onChatState);
    socket.on("SESSION_ENDED",          onSessionEnded);
    socket.on("SLACK_INVITE_UNAVAILABLE", onSlackUnavailable);
    socket.on("connect_error", (e) => console.log("connect_error", e.message));

    return () => {
      socket.off("connect",                   onConnect);
      socket.off("LOBBY_STATE",               onLobbyState);
      socket.off("IDENTIFIED",                onIdentified);
      socket.off("INVITE_RECEIVED",           onInviteReceived);
      socket.off("INVITE_RESULT",             onInviteResult);
      socket.off("INVITE_EXPIRED",            onInviteExpired);
      socket.off("SESSION_STARTED",           onSessionStarted);
      socket.off("CHESS_STATE",               onChessState);
      socket.off("C4_STATE",                  onC4State);
      socket.off("CHAT_STATE",                onChatState);
      socket.off("SESSION_ENDED",             onSessionEnded);
      socket.off("SLACK_INVITE_UNAVAILABLE",  onSlackUnavailable);
    };
  }, [socket]);

  // ── Send Slack invite ─────────────────────────────────────────────────────
  async function handleSlackInviteSend() {
    if (!slackUsername.trim()) return;
    setSlackLoading(true);
    setSlackStatus(null);
    try {
      const res  = await fetch(`${SERVER}/slack/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slackUsername: slackUsername.trim(),
          activityType: slackActivity,
          fromDisplayName: me,
          fromUserId: myUserId,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setSlackStatus({ ok: true, msg: `✅ Invite sent to @${slackUsername}! The game will start automatically when they click the link.` });
        setSlackUsername("");
      } else {
        setSlackStatus({ ok: false, msg: `❌ ${data.error ?? "Failed to send invite"}` });
      }
    } catch {
      setSlackStatus({ ok: false, msg: "❌ Could not reach server" });
    } finally {
      setSlackLoading(false);
    }
  }

  // ── Session view ──────────────────────────────────────────────────────────
  if (session) {
    return (
      <div style={{ padding: 16, fontFamily: "sans-serif" }}>
        <h2>Breakroom Session</h2>
        <p>With: <b>{session.peerDisplayName}</b></p>

        {chessState && session.activityType === "chess" && (
          <>
            <p>Turn: {chessState.turn === "w" ? "White" : "Black"}</p>
            <ChessActivity
              fen={chessState.fen}
              playerColor={session.playerColor}
              onMove={(move) => socket.emit("CHESS_MOVE", { sessionId: session.sessionId, ...move })}
            />
          </>
        )}

        {c4State && session.activityType === "connect4" && (
          <Connect4Activity
            board={c4State.board} turn={c4State.turn} winner={c4State.winner}
            myColor={session.playerColor === "w" ? "r" : "y"}
            onDrop={(col) => socket.emit("C4_DROP", { sessionId: session.sessionId, col })}
            onRematch={() => socket.emit("C4_REMATCH", { sessionId: session.sessionId })}
          />
        )}

        <div style={{ marginTop: 16, maxWidth: 500 }}>
          <h3>Chat</h3>
          <div style={{ border: "1px solid #ccc", minHeight: 120, maxHeight: 200, overflowY: "auto", padding: 8, marginBottom: 8 }}>
            {chatMessages.length === 0
              ? <div>No messages yet.</div>
              : chatMessages.map((msg, i) => (
                  <div key={i} style={{ marginBottom: 6 }}><b>{msg.senderDisplayName}:</b> {msg.text}</div>
                ))}
          </div>
          <input
            type="text" value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && chatInput.trim()) {
                socket.emit("CHAT_SEND", { sessionId: session.sessionId, text: chatInput });
                setChatInput("");
              }
            }}
            placeholder="Type a message..." style={{ width: 300, marginRight: 8 }}
          />
          <button onClick={() => {
            if (!chatInput.trim()) return;
            socket.emit("CHAT_SEND", { sessionId: session.sessionId, text: chatInput });
            setChatInput("");
          }}>Send</button>
        </div>

        <button onClick={() => socket.emit("SESSION_LEAVE", { sessionId: session.sessionId })} style={{ marginTop: 12 }}>
          Leave Session
        </button>
      </div>
    );
  }

  // ── Lobby view ────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 16, fontFamily: "sans-serif" }}>
      <h2>Breakroom Lobby</h2>
      <p>Me: <b>{me}</b></p>

      {/* Slack invite unavailable warning */}
      {slackUnavailable && (
        <div style={{ background: "#fff3e0", border: "1px solid #ff9800", padding: 12, marginBottom: 16, borderRadius: 6 }}>
          ⚠️ {slackUnavailable}
          <button style={{ marginLeft: 12 }} onClick={() => setSlackUnavailable(null)}>Dismiss</button>
        </div>
      )}

      {inviteStatus && <p style={{ color: "green" }}><b>Status:</b> {inviteStatus}</p>}

      {incomingInvite && (
        <div style={{ border: "1px solid #ccc", padding: 12, marginBottom: 12 }}>
          <div>Invite from <b>{incomingInvite.fromDisplayName}</b> for <b>{incomingInvite.activityType}</b></div>
          <button onClick={() => { socket.emit("INVITE_ACCEPT", { inviteId: incomingInvite.inviteId }); setExpiredInviteMessage(""); setIncomingInvite(null); }} style={{ marginRight: 8 }}>Accept</button>
          <button onClick={() => { socket.emit("INVITE_DECLINE", { inviteId: incomingInvite.inviteId }); setExpiredInviteMessage(""); setIncomingInvite(null); }}>Decline</button>
        </div>
      )}

      {expiredInviteMessage && (
        <div style={{ border: "1px solid #ccc", padding: 12, marginBottom: 12 }}>{expiredInviteMessage}</div>
      )}

      {inviteTargetUserId && (
        <div style={{ border: "1px solid #ccc", padding: 12, marginBottom: 12 }}>
          <div style={{ marginBottom: 8 }}>Select activity before sending invite</div>
          <select value={selectedActivity} onChange={(e) => setSelectedActivity(e.target.value as ActivityType)} style={{ marginRight: 8 }}>
            <option value="chess">Chess</option>
            <option value="connect4">Connect 4</option>
          </select>
          <button onClick={() => { socket.emit("INVITE_SEND", { toUserId: inviteTargetUserId, activityType: selectedActivity }); setInviteTargetUserId(null); }} style={{ marginRight: 8 }}>Send Invite</button>
          <button onClick={() => setInviteTargetUserId(null)}>Cancel</button>
        </div>
      )}

      <h3>Users in lobby ({users.length})</h3>
      <ul>
        {users.map((u) => (
          <li key={u.userId}>
            {u.displayName} ({u.presence})
            {u.userId !== myUserId && (
              <button style={{ marginLeft: 8 }} onClick={() => { setInviteStatus(""); setSelectedActivity("chess"); setInviteTargetUserId(u.userId); }}>
                Invite
              </button>
            )}
          </li>
        ))}
      </ul>

      {/* Slack invite section */}
      <div style={{ marginTop: 24, borderTop: "1px solid #eee", paddingTop: 16 }}>
        <h3>💬 Invite via Slack</h3>
        <p style={{ color: "#555", fontSize: 14 }}>
          Send a Slack DM with a join link. When they click it, the game starts immediately — no lobby needed.
        </p>

        {!showSlackInvite ? (
          <button onClick={() => { setShowSlackInvite(true); setSlackStatus(null); }}>
            Send Slack Invite
          </button>
        ) : (
          <div style={{ border: "1px solid #ccc", padding: 12, borderRadius: 6, maxWidth: 400 }}>
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: "block", marginBottom: 4, fontWeight: "bold" }}>Their Slack username or email</label>
              <input
                type="text" value={slackUsername} autoFocus
                onChange={(e) => setSlackUsername(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSlackInviteSend(); }}
                placeholder="e.g. jane or jane@example.com"
                style={{ width: "100%", marginBottom: 8, boxSizing: "border-box" }}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", marginBottom: 4, fontWeight: "bold" }}>Game</label>
              <select value={slackActivity} onChange={(e) => setSlackActivity(e.target.value as ActivityType)} style={{ width: "100%" }}>
                <option value="chess">Chess ♟️</option>
                <option value="connect4">Connect 4 🔴</option>
              </select>
            </div>
            <button onClick={handleSlackInviteSend} disabled={slackLoading || !slackUsername.trim()} style={{ marginRight: 8 }}>
              {slackLoading ? "Sending..." : "Send"}
            </button>
            <button onClick={() => { setShowSlackInvite(false); setSlackStatus(null); setSlackUsername(""); }}>Cancel</button>
            {slackStatus && (
              <p style={{ marginTop: 10, color: slackStatus.ok ? "green" : "red" }}>{slackStatus.msg}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
