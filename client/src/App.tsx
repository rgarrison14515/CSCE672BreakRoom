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

  const socket: Socket = useMemo(() => {
    return io("http://localhost:3001", { transports: ["websocket"] });
  }, []);

  useEffect(() => {
  const name = `User-${Math.floor(Math.random() * 1000)}`;
  setMe(name);

  const onConnect = () => socket.emit("IDENTIFY", { displayName: name });
  const onLobbyState = (payload: { users: PublicUser[] }) => setUsers(payload.users);

  socket.on("connect", onConnect);
  socket.on("LOBBY_STATE", onLobbyState);

  // add these for debugging:
  socket.on("connect_error", (err) => console.log("connect_error", err.message));
  socket.on("disconnect", (reason) => console.log("disconnected:", reason));

  return () => {
    socket.off("connect", onConnect);
    socket.off("LOBBY_STATE", onLobbyState);
    socket.off("connect_error");
    socket.off("disconnect");
  };
}, [socket]);

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif" }}>
      <h2>Breakroom Lobby</h2>
      <p>Me: {me}</p>
      <h3>Users in lobby ({users.length})</h3>
      <ul>
        {users.map((u) => (
          <li key={u.userId}>{u.displayName}</li>
        ))}
      </ul>
    </div>
  );
}