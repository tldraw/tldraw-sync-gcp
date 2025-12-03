import { createServer, IncomingMessage } from "http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";
import { handleAssetUpload, handleAssetDownload } from "./gcsStorage.js";
import { handleUnfurlRequest } from "./unfurl.js";
import { roomManager } from "./roomManager.js";
// 1. Import the metrics we defined
import {
  register,
  activeConnectionsGauge,
  httpRequestDurationMicroseconds,
  errorCounter,
} from "./metrics.js";

const app = express();
const port = process.env.PORT || 3001;
const server = createServer(app);

// 2. Add Middleware to track Latency & HTTP Errors
app.use((req, res, next) => {
  // Start the timer
  const end = httpRequestDurationMicroseconds.startTimer();

  res.on("finish", () => {
    // Stop the timer and record duration when response sends
    end({ method: req.method, route: req.path, code: res.statusCode });

    // Track HTTP errors (4xx and 5xx)
    if (res.statusCode >= 400) {
      errorCounter.inc({ type: "http_error" });
    }
  });
  next();
});

app.use(express.json());

const wss = new WebSocketServer({ noServer: true });

app.get("/api/health", (req, res) => {
  res.status(200).send("ok");
});

// 3. Expose the /metrics endpoint for Prometheus/Google Monitoring
app.get("/metrics", async (req, res) => {
  try {
    res.setHeader("Content-Type", register.contentType);
    res.send(await register.metrics());
  } catch (err) {
    res.status(500).send(err);
  }
});

// --- API Routes ---
app.post("/api/uploads/:uploadId", handleAssetUpload);
app.get("/api/uploads/:uploadId", handleAssetDownload);
app.get("/api/unfurl", handleUnfurlRequest);

// --- WebSocket Upgrade Handling ---

server.on("upgrade", (request: IncomingMessage, socket, head) => {
  if (!request.url) {
    socket.destroy();
    return;
  }

  const { pathname, searchParams } = new URL(
    request.url,
    `http://${request.headers.host}`
  );

  const roomMatch = pathname.match(/\/api\/connect\/(.*)/);
  const roomId = roomMatch?.[1];
  const sessionId = searchParams.get("sessionId");

  if (roomMatch && roomId && sessionId) {
    wss.handleUpgrade(request, socket, head, (ws) => {
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

    // 4. Track Active Connections
    activeConnectionsGauge.inc();

    // Decrease count when they disconnect
    ws.on("close", () => {
      activeConnectionsGauge.dec();
    });

    try {
      roomManager.getOrCreateRoom(roomId, ws, sessionId);
    } catch (err) {
      console.error(
        `[WebSocket] Failed to handle connection for room ${roomId}:`,
        err
      );
      // 5. Track Critical Errors
      errorCounter.inc({ type: "websocket_error" });
      ws.close(1011, "Internal server error");
    }
  }
);

// Start the HTTP server
server.listen(port, () => {
  console.log(`Tldraw GCP server listening on port ${port}`);
});
