import { createServer, IncomingMessage } from "http";
import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";
import { handleAssetUpload, handleAssetDownload } from "./gcsStorage.js";
import { handleUnfurlRequest } from "./unfurl.js";

import {
  register,
  activeConnectionsGauge,
  httpRequestDurationMicroseconds,
  errorCounter,
} from "./metrics.js";
import { roomManager } from "./roomManager.js";

const app = express();
const port = process.env.PORT || 3001;
const server = createServer(app);

app.use(cors({ origin: "*" }));

app.use((req, res, next) => {
  const end = httpRequestDurationMicroseconds.startTimer();

  res.on("finish", () => {
    end({ method: req.method, route: req.path, code: res.statusCode });

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

app.get("/metrics", async (req, res) => {
  try {
    res.setHeader("Content-Type", register.contentType);
    res.send(await register.metrics());
  } catch (err) {
    res.status(500).send(err);
  }
});

app.post("/api/uploads/:uploadId", handleAssetUpload);
app.get("/api/uploads/:uploadId", handleAssetDownload);
app.get("/api/unfurl", handleUnfurlRequest);

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
    socket.destroy();
  }
});

wss.on(
  "connection",
  (
    ws: WebSocket,
    request: IncomingMessage,
    roomId: string,
    sessionId: string
  ) => {
    activeConnectionsGauge.inc();

    ws.on("close", () => {
      activeConnectionsGauge.dec();
    });

    try {
      roomManager.getOrCreateRoom(roomId, ws, sessionId);
    } catch (err) {
      errorCounter.inc({ type: "websocket_error" });
      ws.close(1011, "Internal server error");
    }
  }
);

server.listen(port);
