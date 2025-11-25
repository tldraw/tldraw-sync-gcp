import { createServer, IncomingMessage } from "http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";

// IMPORTANT: Ensure these import paths match your actual filenames in /src
// and ALWAYS keep the .js extension at the end.
import { handleAssetUpload, handleAssetDownload } from "./gcsStorage.js";
import { handleUnfurlRequest } from "./unfurl.js";
import { roomManager } from "./roomManager.js";

const app = express();
const port = process.env.PORT || 3001;
const server = createServer(app);

// Middleware to parse JSON bodies (needed for some API requests)
app.use(express.json());

// 1. Create a WebSocket server (noServer mode lets us handle the upgrade manually)
const wss = new WebSocketServer({ noServer: true });

// 2. Health check endpoint (used by GKE/Docker)
app.get("/api/health", (req, res) => {
  res.status(200).send("ok");
});

// --- HTTP API Routes ---

// 3. Asset Uploads (Images/Videos)
app.post("/api/uploads/:uploadId", handleAssetUpload);

// 4. Asset Downloads
app.get("/api/uploads/:uploadId", handleAssetDownload);

// 5. Link Unfurling (Bookmark previews)
app.get("/api/unfurl", handleUnfurlRequest);

// --- WebSocket Upgrade Handling ---

server.on("upgrade", (request: IncomingMessage, socket, head) => {
  if (!request.url) {
    socket.destroy();
    return;
  }

  // Parse the URL to get the Path and Query Parameters
  const { pathname, searchParams } = new URL(
    request.url,
    `http://${request.headers.host}`
  );

  // Extract roomId from the path: /api/connect/ROOM_ID
  const roomMatch = pathname.match(/\/api\/connect\/(.*)/);
  const roomId = roomMatch?.[1];

  // Extract sessionId from the query params: ?sessionId=...
  const sessionId = searchParams.get("sessionId");

  // Only allow connection if we have both IDs
  if (roomMatch && roomId && sessionId) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Emit the connection event with our extra data
      wss.emit("connection", ws, request, roomId, sessionId);
    });
  } else {
    console.warn(
      `[WebSocket] Rejecting connection: missing roomId or sessionId`
    );
    socket.destroy();
  }
});

// --- WebSocket Connection Logic ---

wss.on(
  "connection",
  (
    ws: WebSocket,
    request: IncomingMessage,
    roomId: string,
    sessionId: string
  ) => {
    console.log(
      `[WebSocket] Client ${sessionId} connecting to room: ${roomId}`
    );

    try {
      // Pass the socket and IDs to the RoomManager
      // It will handle Redis locking, room creation, and the Tldraw sync logic
      roomManager.getOrCreateRoom(roomId, ws, sessionId);
    } catch (err) {
      console.error(
        `[WebSocket] Failed to handle connection for room ${roomId}:`,
        err
      );
      // Close with an internal server error code
      ws.close(1011, "Internal server error");
    }
  }
);

// Start the HTTP server
server.listen(port, () => {
  console.log(`Tldraw GCP server listening on port ${port}`);
});
