import { createServer, IncomingMessage } from "http"
import express from "express"
import cors from "cors"
import { WebSocketServer, WebSocket } from "ws"
import { URL } from "url"
import { handleAssetUpload, handleAssetDownload } from "./s3Storage.js"
import { handleUnfurlRequest } from "./unfurl.js"

import {
  register,
  activeConnectionsGauge,
  httpRequestDurationMicroseconds,
  errorCounter,
} from "./metrics.js"
import { roomManager } from "./roomManager.js"

const app = express()
const port = process.env.PORT || 3001
const server = createServer(app)

app.use(cors({ origin: "*" }))

app.use((req, res, next) => {
  const end = httpRequestDurationMicroseconds.startTimer()

  res.on("finish", () => {
    end({ method: req.method, route: req.path, code: res.statusCode })

    if (res.statusCode >= 400) {
      errorCounter.inc({ type: "http_error" })
    }
  })
  next()
})

app.use(express.json())

const wss = new WebSocketServer({ noServer: true })

app.get("/api/health", (req, res) => {
  res.status(200).send("ok")
})

app.get("/metrics", async (req, res) => {
  try {
    res.setHeader("Content-Type", register.contentType)
    res.send(await register.metrics())
  } catch (err) {
    console.error("[Metrics] Failed to generate metrics:", err)
    res.status(500).send("Internal Server Error: Metrics unavailable")
  }
})

app.post("/api/uploads/:uploadId", handleAssetUpload)
app.get("/api/uploads/:uploadId", handleAssetDownload)
app.get("/api/unfurl", handleUnfurlRequest)

const PING_INTERVAL_MS = 25000

server.on("upgrade", async (request: IncomingMessage, socket, head) => {
  if (!request.url) {
    socket.destroy()
    return
  }

  const { pathname, searchParams } = new URL(request.url, `http://${request.headers.host}`)

  const roomMatch = pathname.match(/\/api\/connect\/(.*)/)
  const roomId = roomMatch?.[1]
  const sessionId = searchParams.get("sessionId")

  if (!roomMatch || !roomId || !sessionId) {
    socket.destroy()
    return
  }

  try {
    // Prepare the room BEFORE accepting the WebSocket connection.
    // This ensures the room is ready to receive messages immediately.
    const { room, isNewRoom } = await roomManager.getOrPrepareRoom(roomId)

    // Now accept the WebSocket - the room is ready
    wss.handleUpgrade(request, socket, head, (ws) => {
      activeConnectionsGauge.inc()

      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping()
        }
      }, PING_INTERVAL_MS)

      ws.on("close", () => {
        clearInterval(pingInterval)
        activeConnectionsGauge.dec()
      })

      ws.on("error", () => {
        clearInterval(pingInterval)
      })

      // Connect the socket to the room - this is synchronous now
      roomManager.connectSocket(room, roomId, ws, sessionId, isNewRoom)
    })
  } catch (err: any) {
    // Room preparation failed - reject the WebSocket upgrade
    errorCounter.inc({ type: "websocket_error" })

    if (err.message !== "LOCK_ACQUISITION_FAILED") {
      console.error(`[WebSocket] Failed to prepare room ${roomId}:`, err)
    }

    socket.destroy()
  }
})

// --- NEW: Graceful Shutdown Implementation ---
async function handleShutdown(signal: string) {
  console.log(`\n[${signal}] Signal received. Starting graceful shutdown...`)

  // 1. Stop accepting new HTTP/WS connections
  server.close(() => {
    console.log("HTTP/WS server closed.")
  })

  // 2. Tell RoomManager to save state and unlock rooms
  try {
    await roomManager.shutdown()
  } catch (err) {
    console.error("Error during RoomManager shutdown:", err)
    process.exit(1)
  }

  console.log("Graceful shutdown successful. Exiting.")
  process.exit(0)
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"))
process.on("SIGINT", () => handleShutdown("SIGINT"))

server.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})
