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
import { NotOwnerError, roomManager } from "./roomManager.js"
import { MEMBER_POLL_INTERVAL_MS } from "./registry.js"
import type { Duplex } from "stream"

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

// Flipped at the very start of drain so routers and probes stop sending work
// here while Rooms are still being handed back.
let draining = false

/**
 * Answer a WebSocket upgrade with a plain HTTP response. `ws` never sees the
 * socket, so the status line has to be written by hand.
 */
function refuseUpgrade(
  socket: Duplex,
  status: number,
  statusText: string,
  headers: Record<string, string> = {},
) {
  const head = [
    `HTTP/1.1 ${status} ${statusText}`,
    "Connection: close",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ]
  socket.end(`${head.join("\r\n")}\r\n\r\n`)
}

app.get("/api/health", (req, res) => {
  if (draining) return res.status(503).send("draining")
  // A worker that cannot write Snapshots should be restarted, not kept alive
  // holding Rooms it can never save.
  if (!roomManager.healthy) return res.status(503).send("cannot persist")
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

// Cluster-internal, unauthenticated: a NetworkPolicy is what keeps it private.
// Acting on it is safe in a way that trusting the opposite would not be —
// dropping a Room we still own costs a reclaim on the next connect, whereas
// keeping one we have lost means serving state that has moved.
app.post("/internal/lost", (req, res) => {
  const roomId = (req.body as { roomId?: string } | undefined)?.roomId
  if (roomId) roomManager.onOwnershipLost(roomId)
  res.status(204).end()
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
  } catch (err: unknown) {
    errorCounter.inc({ type: "websocket_error" })

    // Refusal carries the correction rather than just failing: a mode B router
    // retries against the named address on the same client connection, so the
    // race is invisible to the client.
    if (err instanceof NotOwnerError) {
      refuseUpgrade(socket, 409, "Conflict", err.owner ? { "x-room-owner": err.owner } : {})
      return
    }

    console.error(`[WebSocket] Failed to prepare room ${roomId}:`, err)
    socket.destroy()
  }
})

// --- NEW: Graceful Shutdown Implementation ---
// The order here is load-bearing. Deregistering first and waiting for routers
// to notice is what stops a Room being reallocated straight back onto the
// worker that is shutting down. The wait keys off the router's poll interval,
// not MEMBER_TTL: the record is deleted, not left to go stale.
async function handleShutdown(signal: string) {
  console.log(`\n[${signal}] Signal received. Starting graceful shutdown...`)
  draining = true

  // 1. Stop taking new Sessions, and leave the live set so routers stop
  //    resolving Rooms to us. server.close() refuses new connections without
  //    disturbing established ones, so it belongs here rather than after the
  //    drain: persisting while new Sessions still arrive would race a Snapshot
  //    against edits that landed after it was taken.
  server.close(() => console.log("HTTP/WS server closed."))
  await roomManager.membership.stop()

  // 2. Give every router at least two polls to see us go.
  await new Promise((resolve) => setTimeout(resolve, 2 * MEMBER_POLL_INTERVAL_MS))

  // 3. Persist, vacate, and close Sessions 1013.
  try {
    await roomManager.drain()
  } catch (err) {
    console.error("Error draining rooms:", err)
    process.exit(1)
  }

  console.log("Graceful shutdown successful. Exiting.")
  process.exit(0)
}

process.on("SIGTERM", () => handleShutdown("SIGTERM"))
process.on("SIGINT", () => handleShutdown("SIGINT"))

server.listen(port, () => {
  roomManager.membership.start()
  console.log(`Server listening on port ${port} as ${roomManager.addr}`)
})
