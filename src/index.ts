import { createServer } from "http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";

const app = express();
const port = process.env.PORT || 3001;
const server = createServer(app);

// 1. Create a WebSocket server
const wss = new WebSocketServer({ noServer: true });

// 2. GKE health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).send("ok");
});

// 3. Handle WebSocket upgrades
server.on("upgrade", (request, socket, head) => {
  if (!request.url) {
    socket.destroy();
    return;
  }

  const { pathname } = new URL(request.url, `http://${request.headers.host}`);

  // Match the path for room connections
  const roomMatch = pathname.match(/\/api\/connect\/(.*)/);

  if (roomMatch) {
    const roomId = roomMatch[1];
    if (!roomId) {
      socket.destroy();
      return;
    }

    // Let the WebSocket server handle the connection
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Pass the WebSocket and roomId to our connection handler
      wss.emit("connection", ws, request, roomId);
    });
  } else {
    // For all other paths, destroy the connection
    socket.destroy();
  }
});

// 4. WebSocket connection handler
wss.on("connection", (ws: WebSocket, request: unknown, roomId: string) => {
  console.log(`[WebSocket] Client connected to room: ${roomId}`);

  // We will add RoomManager logic here in the next step

  ws.on("message", (message: Buffer) => {
    console.log(
      `[WebSocket] Received message for room ${roomId}: ${message
        .toString()
        .slice(0, 50)}...`
    );
  });

  ws.on("close", () => {
    console.log(`[WebSocket] Client disconnected from room: ${roomId}`);
  });

  ws.on("error", (error) => {
    console.error(`[WebSocket] Error in room ${roomId}:`, error);
  });
});

// Start the HTTP server
server.listen(port, () => {
  console.log(`Tldraw GCP server listening on port ${port}`);
});
