const { io } = require("socket.io-client");

// Replace with your backend server URL if different
const SERVER_URL = "http://localhost:4000";

const socket = io("https://localhost:4000", {
  transports: ["websocket","polling"],
  autoConnect: true,
});

socket.on("connect", () => {
  console.log("Connected to server with id:", socket.id);
});

socket.on("disconnect", () => {
  console.log("Disconnected from server");
});

socket.on("connect_error", (error) => {
  console.error("Connection error:", error.message);
});

// Optional: disconnect after 20 seconds
setTimeout(() => {
  console.log("Disconnecting from server...");
  socket.disconnect();
}, 20000);
