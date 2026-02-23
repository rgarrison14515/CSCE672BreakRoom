import { useEffect, useMemo, useState } from "react";
import { io, Socket } from "socket.io-client";

type PublicUser = {
  userId: string;
  displayName: string;
  presence: "in_lobby";
};

export default function App() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [me, setMe] = useState("");
  const [myUserId, setMyUserId] = useState("");
  const [incomingInvite, setIncomingInvite] = useState<{
    inviteId: string;
    fromUserId: string;
    fromDisplayName: string;
  } | null>(null);
  const [inviteStatus, setInviteStatus] = useState<string>("");


  const socket: Socket = useMemo(() => {
    return io("http://localhost:3001", { transports: ["websocket"] });
  }, []);

  useEffect(() => {
    const name = `User-${Math.floor(Math.random() * 1000)}`;
    setMe(name);

    const onConnect = () => socket.emit("IDENTIFY", { displayName: name });
    const onLobbyState = (payload: { users: PublicUser[] }) => setUsers(payload.users);
    const onIdentified = (payload: { userId: string }) => setMyUserId(payload.userId);
    const onInviteReceived = (payload: { inviteId: string; fromUserId: string; fromDisplayName: string }) => {
      setIncomingInvite(payload);
    };
    const onInviteResult = (payload: { inviteId: string; result: "success" | "failed" }) => {
      setInviteStatus(`Invite ${payload.result} (${payload.inviteId})`);
    };

    socket.on("connect", onConnect);
    socket.on("LOBBY_STATE", onLobbyState);
    socket.on("IDENTIFIED", onIdentified);
    socket.on("INVITE_RECEIVED", onInviteReceived);
    socket.on("INVITE_RESULT", onInviteResult);

    socket.on("connect_error", (err) => console.log("connect_error", err.message));
    socket.on("disconnect", (reason) => console.log("disconnected:", reason));

    return () => {
      socket.off("connect", onConnect);
      socket.off("LOBBY_STATE", onLobbyState);
      socket.off("IDENTIFIED", onIdentified);
      socket.off("INVITE_RECEIVED", onInviteReceived);
      socket.off("INVITE_RESULT", onInviteResult);
      socket.off("connect_error");
      socket.off("disconnect");
    };
}, [socket]);

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
            Invite from <b>{incomingInvite.fromDisplayName}</b>
          </div>
          <button
            onClick={() => {
              socket.emit("INVITE_ACCEPT", { inviteId: incomingInvite.inviteId });
              setIncomingInvite(null);
            }}
            style={{ marginRight: 8 }}
          >
            Accept
          </button>
          <button
            onClick={() => {
              socket.emit("INVITE_DECLINE", { inviteId: incomingInvite.inviteId });
              setIncomingInvite(null);
            }}
          >
            Decline
          </button>
        </div>
      )}

      <h3>Users in lobby ({users.length})</h3>
      <ul>
        {users.map((u) => (
          <li key={u.userId}>
            {u.displayName}
            {u.userId !== myUserId && (
              <button
                style={{ marginLeft: 8 }}
                onClick={() => socket.emit("INVITE_SEND", { toUserId: u.userId })}
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