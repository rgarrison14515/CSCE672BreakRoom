import { useEffect, useMemo, useState } from "react";
import { io, Socket } from "socket.io-client";
import ChessActivity from "./components/ChessActivity";

type ActivityType = "chess";

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
  const [session, setSession] = useState<{
    sessionId: string;
    peerUserId: string;
    peerDisplayName: string;
    activityType: ActivityType;
    playerColor: "w" | "b";
  } | null>(null);

  const [expiredInviteMessage, setExpiredInviteMessage] = useState<string>("");
  const [chessState, setChessState] = useState<{
    fen: string;
    turn: "w" | "b";
  } | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");


  const socket: Socket = useMemo(() => {
    return io("http://localhost:3001", { transports: ["websocket"] });
  }, []);

  useEffect(() => {
    const name = `User-${Math.floor(Math.random() * 1000)}`;
    setMe(name);

    const onConnect = () => socket.emit("IDENTIFY", { displayName: name });
    const onLobbyState = (payload: { users: PublicUser[] }) => setUsers(payload.users);
    const onIdentified = (payload: { userId: string }) => setMyUserId(payload.userId);
    const onInviteReceived = (payload: {
      inviteId: string;
      fromUserId: string;
      fromDisplayName: string;
      activityType: ActivityType;
    }) => {
      setExpiredInviteMessage("");
      setIncomingInvite(payload);
    };
    const onInviteResult = (payload: { inviteId: string; result: "success" | "failed" }) => {
      if (payload.result === "failed") {
        setInviteStatus("Invitation failed.");
      } 
      else{
        setInviteStatus("");
      }
    };
    const onInviteExpired = (payload: {
      inviteId: string;
      fromDisplayName: string;
      activityType: ActivityType;
    }) => {
      setExpiredInviteMessage(
        `Invite from ${payload.fromDisplayName} for ${payload.activityType} expired.`
      );
      setIncomingInvite(null);
    };

    const onSessionStarted = (payload: {
      sessionId: string;
      peerUserId: string;
      peerDisplayName: string;
      activityType: ActivityType;
      playerColor: "w" | "b";
    }) => {
      setInviteStatus("");
      setSession(payload);
    };

    const onSessionEnded = (payload: { sessionId: string }) => {
      setSession(null);
      setChessState(null);
      setInviteStatus("");
      setChatMessages([]);
      setChatInput("");
    };

    const onChessState = (payload: {
      sessionId: string;
      fen: string;
      turn: "w" | "b";
    }) => {
      setChessState({
        fen: payload.fen,
        turn: payload.turn,
      });
    };

    const onChatState = (payload: {
      sessionId: string;
      messages: ChatMessage[];
    }) => {
      setChatMessages(payload.messages);
    };

    socket.on("connect", onConnect);
    socket.on("LOBBY_STATE", onLobbyState);
    socket.on("IDENTIFIED", onIdentified);
    socket.on("INVITE_RECEIVED", onInviteReceived);
    socket.on("INVITE_RESULT", onInviteResult);
    socket.on("INVITE_EXPIRED", onInviteExpired);
    socket.on("SESSION_STARTED", onSessionStarted);
    socket.on("CHESS_STATE", onChessState);
    socket.on("CHAT_STATE", onChatState);
    socket.on("connect_error", (err) => console.log("connect_error", err.message));
    socket.on("disconnect", (reason) => console.log("disconnected:", reason));
    socket.on("SESSION_ENDED", onSessionEnded);

    return () => {
      socket.off("connect", onConnect);
      socket.off("LOBBY_STATE", onLobbyState);
      socket.off("IDENTIFIED", onIdentified);
      socket.off("INVITE_RECEIVED", onInviteReceived);
      socket.off("INVITE_RESULT", onInviteResult);
      socket.off("INVITE_EXPIRED", onInviteExpired);
      socket.off("connect_error");
      socket.off("disconnect");
      socket.off("SESSION_STARTED", onSessionStarted);
      socket.off("CHESS_STATE", onChessState);
      socket.off("CHAT_STATE", onChatState);
      socket.off("SESSION_ENDED", onSessionEnded);
    };
}, [socket]);


  if (session) {
      return (
        <div style={{ padding: 16, fontFamily: "sans-serif" }}>
          <h2>Breakroom Session</h2>
          <p>Session ID: {session.sessionId}</p>
          <p>With: {session.peerDisplayName}</p>
          
          {chessState && (
            <>
              <p>Turn: {chessState.turn === "w" ? "White" : "Black"}</p>
              <ChessActivity
                fen={chessState.fen}
                playerColor={session.playerColor}
                onMove={(move) => {
                  socket.emit("CHESS_MOVE", {
                    sessionId: session.sessionId,
                    ...move,
                  });
                }}
/>
            </>
          )}
          

                    <div style={{ marginTop: 16, maxWidth: 500 }}>
            <h3>Chat</h3>

            <div
              style={{
                border: "1px solid #ccc",
                minHeight: 120,
                maxHeight: 200,
                overflowY: "auto",
                padding: 8,
                marginBottom: 8,
              }}
            >
              {chatMessages.length === 0 ? (
                <div>No messages yet.</div>
              ) : (
                chatMessages.map((msg, index) => (
                  <div key={index} style={{ marginBottom: 6 }}>
                    <b>{msg.senderDisplayName}:</b> {msg.text}
                  </div>
                ))
              )}
            </div>
            
            <div>
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Type a message..."
                style={{ width: 300, marginRight: 8 }}
              />
              <button
                onClick={() => {
                  if (!chatInput.trim()) return;

                  socket.emit("CHAT_SEND", {
                    sessionId: session.sessionId,
                    text: chatInput,
                  });
                  setChatInput("");
                }}
              >
                Send
              </button>
            </div>
          </div>

          <button
            onClick={() => {
              socket.emit("SESSION_LEAVE", { sessionId: session.sessionId });
            }}
            style={{ marginTop: 12 }}
          >
            Leave Session
          </button>
        </div>
      );
    }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif" }}>
      <h2>Breakroom Lobby</h2>
      <p>Me: {me}</p>
      <p>My userId: {myUserId}</p>
      {/* Invite result status */}
      {inviteStatus && (
        <p style={{ color: "green" }}>
          <b>Status:</b> {inviteStatus}
        </p>
      )}
      {/* Incoming Invite Box */}
      {incomingInvite && (
        <div style={{ border: "1px solid #ccc", padding: 12, marginBottom: 12 }}>
          <div>
            Invite from <b>{incomingInvite.fromDisplayName}</b> for <b>{incomingInvite.activityType}</b>
          </div>
          <button
            onClick={() => {
              socket.emit("INVITE_ACCEPT", { inviteId: incomingInvite.inviteId });
              setExpiredInviteMessage("");
              setIncomingInvite(null);
            }}
            style={{ marginRight: 8 }}
          >
            Accept
          </button>
          <button
            onClick={() => {
              socket.emit("INVITE_DECLINE", { inviteId: incomingInvite.inviteId });
              setExpiredInviteMessage("");
              setIncomingInvite(null);
            }}
          >
            Decline
          </button>
        </div>
      )}

      {expiredInviteMessage && (
        <div style={{ border: "1px solid #ccc", padding: 12, marginBottom: 12 }}>
          {expiredInviteMessage}
        </div>
      )}

        {inviteTargetUserId && (
          <div style={{ border: "1px solid #ccc", padding: 12, marginBottom: 12 }}>
            <div style={{ marginBottom: 8 }}>
              Select activity before sending invite
            </div>

            <select
              value={selectedActivity}
              onChange={(e) => setSelectedActivity(e.target.value as ActivityType)}
              style={{ marginRight: 8 }}
            >
              <option value="chess">Chess</option>
            </select>

            <button
              onClick={() => {
                socket.emit("INVITE_SEND", {
                  toUserId: inviteTargetUserId,
                  activityType: selectedActivity,
                });
                setInviteTargetUserId(null);
              }}
              style={{ marginRight: 8 }}
            >
              Send Invite
            </button>

            <button
              onClick={() => {
                setInviteTargetUserId(null);
              }}
            >
              Cancel
            </button>
          </div>
      )}

      <h3>Users in lobby ({users.length})</h3>
      <ul>
        {users.map((u) => (
          <li key={u.userId}>
            {u.displayName} ({u.presence})
            {u.userId !== myUserId && (
              <button
                style={{ marginLeft: 8 }}
                onClick={() => {
                  setInviteStatus("");
                  setSelectedActivity("chess");
                  setInviteTargetUserId(u.userId);
                }}
              >
                Invite
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}