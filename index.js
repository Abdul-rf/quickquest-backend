// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000", // React app
    methods: ["GET", "POST"]
  }
});

const PORT = 4000;

// In-memory storage for events
let events = {};

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // Player joins an event
  socket.on("joinEvent", (eventCode, userData) => {
    if (!userData || !userData.playerName) return;

    if (!events[eventCode]) {
      events[eventCode] = { leaderboard: [] };
    }

    socket.join(eventCode);

    console.log(`${userData.playerName} joined ${eventCode}`);

    // Send the current leaderboard
    socket.emit("joinedEvent", {
      eventCode,
      leaderboard: events[eventCode].leaderboard
    });
  });

  // Player submits time
  socket.on("submitTime", (eventCode, submission) => {
    if (!submission || !submission.name) return;
    if (!events[eventCode]) return;

    const leaderboard = events[eventCode].leaderboard;
    const time = parseFloat(submission.time);

    const existing = leaderboard.find(p => p.name === submission.name);

    if (!existing) {
      leaderboard.push({ name: submission.name, time });
    } else if (time < existing.time) {
      existing.time = time;
    }

    // Sort leaderboard by time ascending
    leaderboard.sort((a, b) => a.time - b.time);

    // Broadcast updated leaderboard to all players in this event
    io.to(eventCode).emit("leaderboardUpdate", leaderboard);

    console.log("Leaderboard updated:", leaderboard);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
