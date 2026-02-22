import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

type PublicUser = {
  userId: string;
  displayName: string;
  presence: "in_lobby";
};

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

const usersBySocketId = new Map<string, PublicUser>();

function lobbyState(): { users: PublicUser[] } {
  return { users: Array.from(usersBySocketId.values()) };
}

function broadcastLobby() {
  io.to("lobby").emit("LOBBY_STATE", lobbyState());
}

io.on("connection", (socket) => {
  console.log("connected", socket.id);

  socket.on("IDENTIFY", (payload: { displayName: string }) => {
    // super simple v1: generate userId from socket id
    const user: PublicUser = {
      userId: socket.id,
      displayName: payload.displayName,
      presence: "in_lobby",
    };
    usersBySocketId.set(socket.id, user);

    socket.join("lobby");
    broadcastLobby();
  });

  socket.on("disconnect", () => {
    usersBySocketId.delete(socket.id);
    broadcastLobby();
    console.log("disconnected", socket.id);
  });
});

server.listen(3001, () => {
  console.log("server listening on http://localhost:3001");
});