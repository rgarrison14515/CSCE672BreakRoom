import { useEffect, useMemo, useState } from "react";
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
    inviteId: string;
    fromUserId: string;
    fromDisplayName: string;
    activityType: ActivityType;
  } | null>(null);

  const [inviteStatus, setInviteStatus] = useState<string>("");
  const [inviteTargetUserId, setInviteTargetUserId] = useState<string | null>(null);
  const [selectedActivity, setSelectedActivity] = useState<ActivityType>("chess");
  const [expiredInviteMessage, setExpiredInviteMessage] = useState<string>("");

  const [session, setSession] = useState<{
    sessionId: string;
    peerUserId: string;
    peerDisplayName: string;
    activityType: ActivityType;
    playerColor: "w" | "b";
  } | null>(null);

  const [chessState, setChessState] = useState<{ fen: string; turn: "w" | "b" } | null>(null);
  const [c4State, setC4State] = useState<{
    board: C4Color[][];
    turn: "r" | "y";
    winner: null | "r" | "y" | "draw";
  } | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");

  // Slack invite state
  const [showSlackInvite, setShowSlackInvite] = useState(false);
  const [slackUsername, setSlackUsername] = useState("");
  const [slackActivity, setSlackActivity] = useState<ActivityType>("chess");
  const [slackStatus, setSlackStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [slackLoading, setSlackLoading] = useState(false);

  // Slack join-via-link state
  const [slackJoinInfo, setSlackJoinInfo] = useState<{
    token: string;
    fromDisplayName: string;
    activityType: ActivityType;
  } | null>(null);

  const socket: Socket = useMemo(() => io(SERVER, { transports: ["websocket"] }), []);

  // ── Check for ?slackInvite= in URL on load ──────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("slackInvite");
    const from = params.get("from");
    if (!token) return;

    fetch(`${SERVER}/slack/invite/${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setSlackJoinInfo({
            token,
            fromDisplayName: from ?? data.fromDisplayName,
            activityType: data.activityType,
          });
          // Clean URL
          window.history.replaceState({}, "", "/");
        }
      })
      .catch(() => {});
  }, []);

  // ── Socket events ───────────────────────────────────────────────────────
  useEffect(() => {
    const name = `User-${Math.floor(Math.random() * 1000)}`;
    setMe(name);

    const onConnect = () => socket.emit("IDENTIFY", { displayName: name });
    const onLobbyState = (payload: { users: PublicUser[] }) => setUsers(payload.users);
    const onIdentified = (payload: { userId: string }) => setMyUserId(payload.userId);

    const onInviteReceived = (payload: {
      inviteId: string; fromUserId: string; fromDisplayName: string; activityType: ActivityType;
    }) => { setExpiredInviteMessage(""); setIncomingInvite(payload); };

    const onInviteResult = (payload: { inviteId: string; result: "success" | "failed" }) => {
      if (payload.result === "failed") setInviteStatus("Invitation failed.");
      else setInviteStatus("");
    };

    const onInviteExpired = (payload: { inviteId: string; fromDisplayName: string; activityType: ActivityType }) => {
      setExpiredInviteMessage(`Invite from ${payload.fromDisplayName} for ${payload.activityType} expired.`);
      setIncomingInvite(null);
    };

    const onSessionStarted = (payload: {
      sessionId: string; peerUserId: string; peerDisplayName: string;
      activityType: ActivityType; playerColor: "w" | "b";
    }) => { setInviteStatus(""); setSession(payload); setSlackJoinInfo(null); };

    const onSessionEnded = (_payload: { sessionId: string }) => {
      setSession(null); setChessState(null); setC4State(null);
      setInviteStatus(""); setChatMessages([]); setChatInput("");
    };

    const onChessState = (payload: { sessionId: string; fen: string; turn: "w" | "b" }) =>
      setChessState({ fen: payload.fen, turn: payload.turn });

    const onC4State = (payload: { sessionId: string; board: C4Color[][]; turn: "r" | "y"; winner: null | "r" | "y" | "draw" }) =>
      setC4State({ board: payload.board, turn: payload.turn, winner: payload.winner });

    const onChatState = (payload: { sessionId: string; messages: ChatMessage[] }) =>
      setChatMessages(payload.messages);

    socket.on("connect", onConnect);
    socket.on("LOBBY_STATE", onLobbyState);
    socket.on("IDENTIFIED", onIdentified);
    socket.on("INVITE_RECEIVED", onInviteReceived);
    socket.on("INVITE_RESULT", onInviteResult);
    socket.on("INVITE_EXPIRED", onInviteExpired);
    socket.on("SESSION_STARTED", onSessionStarted);
    socket.on("CHESS_STATE", onChessState);
    socket.on("C4_STATE", onC4State);
    socket.on("CHAT_STATE", onChatState);
    socket.on("SESSION_ENDED", onSessionEnded);
    socket.on("connect_error", (err) => console.log("connect_error", err.message));

    return () => {
      socket.off("connect", onConnect);
      socket.off("LOBBY_STATE", onLobbyState);
      socket.off("IDENTIFIED", onIdentified);
      socket.off("INVITE_RECEIVED", onInviteReceived);
      socket.off("INVITE_RESULT", onInviteResult);
      socket.off("INVITE_EXPIRED", onInviteExpired);
      socket.off("SESSION_STARTED", onSessionStarted);
      socket.off("CHESS_STATE", onChessState);
      socket.off("C4_STATE", onC4State);
      socket.off("CHAT_STATE", onChatState);
      socket.off("SESSION_ENDED", onSessionEnded);
    };
  }, [socket]);

  // ── Send Slack invite ────────────────────────────────────────────────────
  async function handleSlackInviteSend() {
    if (!slackUsername.trim()) return;
    setSlackLoading(true);
    setSlackStatus(null);
    try {
      const res = await fetch(`${SERVER}/slack/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slackUsername: slackUsername.trim(),
          activityType: slackActivity,
          fromDisplayName: me,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setSlackStatus({ ok: true, msg: `✅ Invite sent to @${slackUsername} on Slack!` });
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

  // ── Session view ─────────────────────────────────────────────────────────
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
            board={c4State.board}
            turn={c4State.turn}
            winner={c4State.winner}
            myColor={session.playerColor === "w" ? "r" : "y"}
            onDrop={(col) => socket.emit("C4_DROP", { sessionId: session.sessionId, col })}
            onRematch={() => socket.emit("C4_REMATCH", { sessionId: session.sessionId })}
          />
        )}

        <div style={{ marginTop: 16, maxWidth: 500 }}>
          <h3>Chat</h3>
          <div style={{ border: "1px solid #ccc", minHeight: 120, maxHeight: 200, overflowY: "auto", padding: 8, marginBottom: 8 }}>
            {chatMessages.length === 0 ? <div>No messages yet.</div> : chatMessages.map((msg, i) => (
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

  // ── Lobby view ───────────────────────────────────────────────────────────
  return (
    <div style={{ padding: 16, fontFamily: "sans-serif" }}>
      <h2>Breakroom Lobby</h2>
      <p>Me: <b>{me}</b></p>

      {/* Slack join banner — shown when arriving via Slack invite link */}
      {slackJoinInfo && (
        <div style={{ background: "#e8f5e9", border: "1px solid #4caf50", padding: 12, marginBottom: 16, borderRadius: 6 }}>
          <p style={{ margin: "0 0 8px" }}>
            🎮 <b>{slackJoinInfo.fromDisplayName}</b> invited you to play <b>{slackJoinInfo.activityType}</b>!
            They'll see you joined once they're in the lobby — just wait here.
          </p>
          <button onClick={() => setSlackJoinInfo(null)}>Dismiss</button>
        </div>
      )}

      {inviteStatus && <p style={{ color: "green" }}><b>Status:</b> {inviteStatus}</p>}

      {/* Incoming lobby invite */}
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

      {/* Lobby invite panel */}
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

      {/* Users list */}
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
        <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span>💬</span> Invite via Slack
        </h3>
        <p style={{ color: "#555", fontSize: 14 }}>
          Send a Slack DM to someone who isn't in the lobby yet. They'll get a link to join your game.
        </p>

        {!showSlackInvite ? (
          <button onClick={() => { setShowSlackInvite(true); setSlackStatus(null); }}>
            Send Slack Invite
          </button>
        ) : (
          <div style={{ border: "1px solid #ccc", padding: 12, borderRadius: 6, maxWidth: 400 }}>
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: "block", marginBottom: 4, fontWeight: "bold" }}>
                Their Slack username or email
              </label>
              <input
                type="text"
                value={slackUsername}
                onChange={(e) => setSlackUsername(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSlackInviteSend(); }}
                placeholder="e.g. jane or jane@example.com"
                style={{ width: "100%", marginBottom: 8, boxSizing: "border-box" }}
                autoFocus
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
            <button onClick={() => { setShowSlackInvite(false); setSlackStatus(null); setSlackUsername(""); }}>
              Cancel
            </button>

            {slackStatus && (
              <p style={{ marginTop: 10, color: slackStatus.ok ? "green" : "red" }}>
                {slackStatus.msg}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
