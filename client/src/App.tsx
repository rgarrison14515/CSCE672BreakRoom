import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import ChessActivity from "./components/ChessActivity";
import Connect4Activity from "./components/Connect4Activity";

type ActivityType = "chess" | "connect4";
type C4Color = null | "r" | "y";

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

const SERVER = "http://localhost:3001";

function initials(name: string) {
  return name.slice(0, 2).toUpperCase();
}

export default function App() {
  const [users, setUsers]           = useState<PublicUser[]>([]);
  const [me, setMe]                 = useState("");
  const [myUserId, setMyUserId]     = useState("");

  const [incomingInvite, setIncomingInvite] = useState<{
    inviteId: string; fromUserId: string; fromDisplayName: string; activityType: ActivityType;
  } | null>(null);

  const [inviteStatus, setInviteStatus]         = useState("");
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
  const chatBoxRef = useRef<HTMLDivElement>(null);

  // Slack state
  const [showSlackInvite, setShowSlackInvite] = useState(false);
  const [slackUsername, setSlackUsername]     = useState("");
  const [slackActivity, setSlackActivity]     = useState<ActivityType>("chess");
  const [slackStatus, setSlackStatus]         = useState<{ ok: boolean; msg: string } | null>(null);
  const [slackLoading, setSlackLoading]       = useState(false);
  const [slackUnavailable, setSlackUnavailable] = useState<string | null>(null);

  const slackInviteTokenRef = useRef<string | null>(null);

  useState(() => {
    const params = new URLSearchParams(window.location.search);
    const token  = params.get("slackInvite");
    if (token) { slackInviteTokenRef.current = token; window.history.replaceState({}, "", "/"); }
  });

  const socket: Socket = useMemo(() => io(SERVER, { transports: ["websocket"] }), []);

  // Auto-scroll chat
  useEffect(() => {
    if (chatBoxRef.current) chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
  }, [chatMessages]);

  useEffect(() => {
    const name = `User-${Math.floor(Math.random() * 1000)}`;
    setMe(name);

    const onConnect    = () => socket.emit("IDENTIFY", { displayName: name, slackInviteToken: slackInviteTokenRef.current ?? undefined });
    const onLobbyState = (p: { users: PublicUser[] }) => setUsers(p.users);
    const onIdentified = (p: { userId: string }) => setMyUserId(p.userId);

    const onInviteReceived = (p: { inviteId: string; fromUserId: string; fromDisplayName: string; activityType: ActivityType }) => {
      setExpiredInviteMessage(""); setIncomingInvite(p);
    };
    const onInviteResult = (p: { result: "success"|"failed" }) => {
      if (p.result === "failed") setInviteStatus("Invitation failed or was declined.");
      else setInviteStatus("");
    };
    const onInviteExpired = (p: { fromDisplayName: string; activityType: ActivityType }) => {
      setExpiredInviteMessage(`Invite from ${p.fromDisplayName} for ${p.activityType} expired.`);
      setIncomingInvite(null);
    };
    const onSessionStarted = (p: { sessionId: string; peerUserId: string; peerDisplayName: string; activityType: ActivityType; playerColor: "w"|"b" }) => {
      setInviteStatus(""); setSession(p);
    };
    const onSessionEnded = () => {
      setSession(null); setChessState(null); setC4State(null);
      setInviteStatus(""); setChatMessages([]); setChatInput("");
    };
    const onChessState = (p: { fen: string; turn: "w"|"b" }) => setChessState({ fen: p.fen, turn: p.turn });
    const onC4State    = (p: { board: C4Color[][]; turn: "r"|"y"; winner: null|"r"|"y"|"draw" }) =>
      setC4State({ board: p.board, turn: p.turn, winner: p.winner });
    const onChatState  = (p: { messages: ChatMessage[] }) => setChatMessages(p.messages);
    const onSlackUnavailable = (p: { fromDisplayName: string }) =>
      setSlackUnavailable(p.fromDisplayName
        ? `${p.fromDisplayName} is no longer available.`
        : "This invite link has expired or the host is unavailable.");

    socket.on("connect",                   onConnect);
    socket.on("LOBBY_STATE",               onLobbyState);
    socket.on("IDENTIFIED",                onIdentified);
    socket.on("INVITE_RECEIVED",           onInviteReceived);
    socket.on("INVITE_RESULT",             onInviteResult);
    socket.on("INVITE_EXPIRED",            onInviteExpired);
    socket.on("SESSION_STARTED",           onSessionStarted);
    socket.on("CHESS_STATE",               onChessState);
    socket.on("C4_STATE",                  onC4State);
    socket.on("CHAT_STATE",                onChatState);
    socket.on("SESSION_ENDED",             onSessionEnded);
    socket.on("SLACK_INVITE_UNAVAILABLE",  onSlackUnavailable);
    socket.on("connect_error", (e) => console.log("connect_error", e.message));

    return () => {
      socket.off("connect", onConnect); socket.off("LOBBY_STATE", onLobbyState);
      socket.off("IDENTIFIED", onIdentified); socket.off("INVITE_RECEIVED", onInviteReceived);
      socket.off("INVITE_RESULT", onInviteResult); socket.off("INVITE_EXPIRED", onInviteExpired);
      socket.off("SESSION_STARTED", onSessionStarted); socket.off("CHESS_STATE", onChessState);
      socket.off("C4_STATE", onC4State); socket.off("CHAT_STATE", onChatState);
      socket.off("SESSION_ENDED", onSessionEnded); socket.off("SLACK_INVITE_UNAVAILABLE", onSlackUnavailable);
    };
  }, [socket]);

  async function handleSlackInviteSend() {
    if (!slackUsername.trim()) return;
    setSlackLoading(true); setSlackStatus(null);
    try {
      const res  = await fetch(`${SERVER}/slack/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slackUsername: slackUsername.trim(), activityType: slackActivity, fromDisplayName: me, fromUserId: myUserId }),
      });
      const data = await res.json();
      if (data.ok) { setSlackStatus({ ok: true, msg: `Invite sent to @${slackUsername}! Game starts when they click the link.` }); setSlackUsername(""); }
      else          setSlackStatus({ ok: false, msg: data.error ?? "Failed to send invite" });
    } catch { setSlackStatus({ ok: false, msg: "Could not reach server" }); }
    finally { setSlackLoading(false); }
  }

  function sendChat() {
    if (!chatInput.trim() || !session) return;
    socket.emit("CHAT_SEND", { sessionId: session.sessionId, text: chatInput });
    setChatInput("");
  }

  // ── SESSION VIEW ──────────────────────────────────────────────────────────
  if (session) {
    return (
      <div className="app-layout">
        <header className="app-header">
          <div className="app-logo">Break<span>room</span></div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 13, color: "var(--text-dim)" }}>Playing with</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div className="user-avatar" style={{ width: 28, height: 28, fontSize: 11, borderRadius: 8 }}>
                {initials(session.peerDisplayName)}
              </div>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{session.peerDisplayName}</span>
            </div>
            <span className="badge">{session.activityType === "chess" ? "♟ Chess" : "🔴 Connect 4"}</span>
          </div>
          <button className="btn-danger btn-sm" onClick={() => socket.emit("SESSION_LEAVE", { sessionId: session.sessionId })}>
            Leave
          </button>
        </header>

        <main className="main-content">
          <div className="session-layout">
            {/* Game area */}
            <div>
              {chessState && session.activityType === "chess" && (
                <ChessActivity
                  fen={chessState.fen}
                  playerColor={session.playerColor}
                  turn={chessState.turn}
                  onMove={(move) => socket.emit("CHESS_MOVE", { sessionId: session.sessionId, ...move })}
                />
              )}
              {c4State && session.activityType === "connect4" && (
                <Connect4Activity
                  board={c4State.board} turn={c4State.turn} winner={c4State.winner}
                  myColor={session.playerColor === "w" ? "r" : "y"}
                  onDrop={(col) => socket.emit("C4_DROP", { sessionId: session.sessionId, col })}
                  onRematch={() => socket.emit("C4_REMATCH", { sessionId: session.sessionId })}
                />
              )}
            </div>

            {/* Sidebar */}
            <div className="session-sidebar">
              {/* Players */}
              <div className="card">
                <div className="card-title">Players</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {[
                    { name: me, color: session.playerColor === "w" ? "White ♙" : "Black ♟", isMe: true },
                    { name: session.peerDisplayName, color: session.playerColor === "w" ? "Black ♟" : "White ♙", isMe: false },
                  ].map((p) => (
                    <div key={p.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div className="user-avatar" style={{ width: 32, height: 32, fontSize: 12, borderRadius: 9 }}>
                        {initials(p.name)}
                      </div>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name} {p.isMe && <span style={{ color: "var(--neon)", fontSize: 11 }}>(you)</span>}</div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>{p.color}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Chat */}
              <div className="card" style={{ flex: 1 }}>
                <div className="card-title">Chat</div>
                <div className="chat-box" ref={chatBoxRef}>
                  {chatMessages.length === 0
                    ? <div className="chat-empty">No messages yet…</div>
                    : chatMessages.map((msg, i) => (
                        <div key={i} className={`chat-msg${msg.senderUserId === myUserId ? " chat-msg-me" : ""}`}>
                          <span className="chat-msg-name">{msg.senderDisplayName}</span>
                          {msg.text}
                        </div>
                      ))
                  }
                </div>
                <div className="chat-input-row">
                  <input
                    type="text" value={chatInput} placeholder="Say something…"
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
                  />
                  <button className="btn-primary btn-sm" onClick={sendChat}>Send</button>
                </div>
              </div>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ── LOBBY VIEW ────────────────────────────────────────────────────────────
  const otherUsers = users.filter(u => u.userId !== myUserId);

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="app-logo">Break<span>room</span></div>
        <div className="badge">Lobby</div>
      </header>

      <main className="main-content">
        {/* Me card */}
        <div className="me-card">
          <div className="me-avatar">{initials(me)}</div>
          <div className="me-info">
            <div className="me-name">{me}</div>
            <div className="me-id">{myUserId || "connecting…"}</div>
          </div>
          <span className="presence-pill lobby">● Online</span>
        </div>

        {/* Alerts */}
        {slackUnavailable && (
          <div className="alert alert-warn">
            ⚠️ {slackUnavailable}
            <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => setSlackUnavailable(null)}>✕</button>
          </div>
        )}
        {inviteStatus && (
          <div className="alert alert-error">
            ✕ {inviteStatus}
            <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => setInviteStatus("")}>✕</button>
          </div>
        )}
        {expiredInviteMessage && (
          <div className="alert alert-warn">
            ⏱ {expiredInviteMessage}
            <button className="btn-ghost btn-sm" style={{ marginLeft: "auto" }} onClick={() => setExpiredInviteMessage("")}>✕</button>
          </div>
        )}

        {/* Incoming invite */}
        {incomingInvite && (
          <div className="alert alert-invite">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="user-avatar">{initials(incomingInvite.fromDisplayName)}</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{incomingInvite.fromDisplayName}</div>
                <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 2 }}>
                  wants to play <strong>{incomingInvite.activityType === "chess" ? "♟ Chess" : "🔴 Connect 4"}</strong>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn-success btn-sm" onClick={() => { socket.emit("INVITE_ACCEPT", { inviteId: incomingInvite.inviteId }); setIncomingInvite(null); }}>
                ✓ Accept
              </button>
              <button className="btn-ghost btn-sm" onClick={() => { socket.emit("INVITE_DECLINE", { inviteId: incomingInvite.inviteId }); setIncomingInvite(null); }}>
                Decline
              </button>
            </div>
          </div>
        )}

        <div className="lobby-grid">
          {/* Left: user list */}
          <div>
            <div className="section-heading">
              Players online <span style={{ color: "var(--neon)", fontFamily: "var(--font-mono)" }}>{users.length}</span>
            </div>

            {/* Invite panel */}
            {inviteTargetUserId && (() => {
              const target = users.find(u => u.userId === inviteTargetUserId);
              return (
                <div className="invite-panel">
                  <div style={{ fontSize: 14, marginBottom: 12 }}>
                    Invite <strong>{target?.displayName}</strong> to play:
                  </div>
                  <label>Game</label>
                  <select value={selectedActivity} onChange={(e) => setSelectedActivity(e.target.value as ActivityType)} style={{ marginBottom: 12 }}>
                    <option value="chess">♟ Chess</option>
                    <option value="connect4">🔴 Connect 4</option>
                  </select>
                  <div className="invite-panel-actions">
                    <button className="btn-primary btn-sm" onClick={() => {
                      socket.emit("INVITE_SEND", { toUserId: inviteTargetUserId, activityType: selectedActivity });
                      setInviteTargetUserId(null);
                    }}>Send Invite</button>
                    <button className="btn-ghost btn-sm" onClick={() => setInviteTargetUserId(null)}>Cancel</button>
                  </div>
                </div>
              );
            })()}

            <div className="user-list">
              {users.length === 0 && (
                <div className="empty-state">
                  <div className="empty-state-icon">👥</div>
                  No one else is here yet
                </div>
              )}
              {users.map((u) => (
                <div key={u.userId} className="user-row">
                  <div className="user-info">
                    <div className="user-avatar">{initials(u.displayName)}</div>
                    <div>
                      <div className={`user-name${u.userId === myUserId ? " me" : ""}`}>
                        {u.displayName}{u.userId === myUserId && " (you)"}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span className={`presence-pill ${u.presence === "in_lobby" ? "lobby" : "session"}`}>
                      {u.presence === "in_lobby" ? "In Lobby" : "In Game"}
                    </span>
                    {u.userId !== myUserId && u.presence === "in_lobby" && (
                      <button
                        className="btn-primary btn-sm"
                        onClick={() => { setInviteStatus(""); setSelectedActivity("chess"); setInviteTargetUserId(u.userId); }}
                      >
                        Invite
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Slack panel */}
          <div>
            <div className="section-heading">Slack Invite</div>
            <div className="card">
              <p style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 16, lineHeight: 1.6 }}>
                Send a direct message to someone on Slack. They'll get a link that drops them straight into your game.
              </p>

              {!showSlackInvite ? (
                <button className="btn-primary" style={{ width: "100%" }} onClick={() => { setShowSlackInvite(true); setSlackStatus(null); }}>
                  💬 Send Slack Invite
                </button>
              ) : (
                <div className="slack-form">
                  <div>
                    <label>Slack username or email</label>
                    <input
                      type="text" value={slackUsername} autoFocus
                      placeholder="jane or jane@example.com"
                      onChange={(e) => setSlackUsername(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSlackInviteSend(); }}
                    />
                  </div>
                  <div>
                    <label>Game</label>
                    <select value={slackActivity} onChange={(e) => setSlackActivity(e.target.value as ActivityType)}>
                      <option value="chess">♟ Chess</option>
                      <option value="connect4">🔴 Connect 4</option>
                    </select>
                  </div>
                  <div className="slack-form-row">
                    <button className="btn-primary btn-sm" onClick={handleSlackInviteSend} disabled={slackLoading || !slackUsername.trim()}>
                      {slackLoading ? <span className="spinner" /> : "Send"}
                    </button>
                    <button className="btn-ghost btn-sm" onClick={() => { setShowSlackInvite(false); setSlackStatus(null); setSlackUsername(""); }}>
                      Cancel
                    </button>
                  </div>
                  {slackStatus && (
                    <div className={`alert ${slackStatus.ok ? "alert-info" : "alert-error"}`} style={{ margin: 0 }}>
                      {slackStatus.ok ? "✓" : "✕"} {slackStatus.msg}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
