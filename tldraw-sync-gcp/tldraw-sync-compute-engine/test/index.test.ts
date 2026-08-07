import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "events"

// src/index.ts does all of its work at module load: it builds the express app,
// registers the upgrade handler, installs signal handlers and calls listen().
// So rather than exporting anything for tests, it is imported once against fakes
// and the things it registered are captured on the way past.

class FakeServer extends EventEmitter {
  listen = vi.fn((_port: unknown, cb?: () => void) => {
    cb?.()
    return this
  })
  close = vi.fn((cb?: () => void) => {
    cb?.()
    return this
  })
}

const fakeServer = new FakeServer()
vi.mock("http", () => ({
  createServer: () => fakeServer,
  IncomingMessage: class {},
}))

// The express app, reduced to a record of what got registered on it.
const routes = new Map<string, (req: any, res: any) => unknown>()
const fakeApp = {
  use: vi.fn(),
  get: vi.fn((path: string, handler: any) => routes.set(`GET ${path}`, handler)),
  post: vi.fn((path: string, handler: any) => routes.set(`POST ${path}`, handler)),
}
vi.mock("express", () => {
  const express: any = () => fakeApp
  express.json = () => (_req: unknown, _res: unknown, next: () => void) => next()
  return { default: express }
})

vi.mock("cors", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

const handleUpgrade = vi.fn()
class FakeWebSocketServer {
  handleUpgrade = handleUpgrade
}
vi.mock("ws", () => ({
  WebSocketServer: FakeWebSocketServer,
  WebSocket: { OPEN: 1, CLOSED: 3 },
}))

const getOrPrepareRoom = vi.fn()
const connectSocket = vi.fn()
const shutdown = vi.fn()
vi.mock("../src/roomManager.js", () => ({
  roomManager: { getOrPrepareRoom, connectSocket, shutdown },
}))

const handleAssetUpload = vi.fn()
const handleAssetDownload = vi.fn()
vi.mock("../src/gcsStorage.js", () => ({ handleAssetUpload, handleAssetDownload }))

const handleUnfurlRequest = vi.fn()
vi.mock("../src/unfurl.js", () => ({ handleUnfurlRequest }))

const metrics = vi.fn()
const activeConnectionsInc = vi.fn()
const activeConnectionsDec = vi.fn()
const errorCounterInc = vi.fn()
vi.mock("../src/metrics.js", () => ({
  register: {
    get contentType() {
      return "text/plain; version=0.0.4"
    },
    metrics,
  },
  activeConnectionsGauge: { inc: activeConnectionsInc, dec: activeConnectionsDec },
  httpRequestDurationMicroseconds: { startTimer: () => vi.fn() },
  errorCounter: { inc: errorCounterInc },
}))

// Capture the signal handlers as index.ts installs them. Emitting the real
// signal would work, but the listener returns the shutdown promise and tests
// need to await it.
const signalHandlers = new Map<string, () => Promise<void>>()
const realProcessOn = process.on.bind(process)
process.on = ((event: string, handler: any) => {
  if (event === "SIGTERM" || event === "SIGINT") {
    signalHandlers.set(event, handler)
    return process
  }
  return realProcessOn(event as any, handler)
}) as typeof process.on

await import("../src/index.js")

process.on = realProcessOn

const upgradeHandler = fakeServer.listeners("upgrade")[0] as (
  req: any,
  socket: any,
  head: any,
) => Promise<void>

function fakeSocket() {
  return { destroy: vi.fn() }
}

function fakeWs(readyState = 1) {
  const ws = new EventEmitter() as EventEmitter & {
    readyState: number
    ping: ReturnType<typeof vi.fn>
  }
  ws.readyState = readyState
  ws.ping = vi.fn()
  return ws
}

function upgradeRequest(url: string | undefined) {
  return { url, headers: { host: "sync.example.com" } }
}

// process.exit does not return, so a mock that does would let shutdown fall
// through its own error branch into the success path — a failure mode that
// cannot happen in production. Throwing models the real control flow.
class ProcessExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

// Runs a shutdown handler and reports how the process would have terminated.
async function exitCodeFrom(handler: () => Promise<void>): Promise<number> {
  try {
    await handler()
  } catch (err) {
    if (err instanceof ProcessExit) return err.code
    throw err
  }
  throw new Error("shutdown returned without exiting")
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  handleUpgrade.mockImplementation((_req, _socket, _head, cb) => cb(fakeWs()))
  getOrPrepareRoom.mockResolvedValue({ room: { id: "room" }, isNewRoom: false })
  metrics.mockResolvedValue("# HELP tldraw_active_rooms\n")
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ProcessExit(code ?? 0)
  }) as never)
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
})

describe("websocket upgrade", () => {
  it("destroys the socket when the request has no url", async () => {
    const socket = fakeSocket()
    await upgradeHandler(upgradeRequest(undefined), socket, null)

    expect(socket.destroy).toHaveBeenCalled()
    expect(getOrPrepareRoom).not.toHaveBeenCalled()
  })

  it("destroys the socket for a path that is not a connect path", async () => {
    const socket = fakeSocket()
    await upgradeHandler(upgradeRequest("/api/uploads/abc?sessionId=s1"), socket, null)

    expect(socket.destroy).toHaveBeenCalled()
    expect(getOrPrepareRoom).not.toHaveBeenCalled()
  })

  // A Session is identified by its sessionId; without one there is nothing to
  // hand to the room, so the connection is refused rather than guessed at.
  it("destroys the socket when sessionId is missing", async () => {
    const socket = fakeSocket()
    await upgradeHandler(upgradeRequest("/api/connect/room-42"), socket, null)

    expect(socket.destroy).toHaveBeenCalled()
    expect(getOrPrepareRoom).not.toHaveBeenCalled()
  })

  it("destroys the socket when the roomId is empty", async () => {
    const socket = fakeSocket()
    await upgradeHandler(upgradeRequest("/api/connect/?sessionId=s1"), socket, null)

    expect(socket.destroy).toHaveBeenCalled()
    expect(getOrPrepareRoom).not.toHaveBeenCalled()
  })

  // The whole point of preparing the room first: the Room Lock is acquired and
  // the Snapshot loaded before the handshake completes, so a client can never
  // send into a room that is not ready.
  it("prepares the room before completing the handshake", async () => {
    const order: string[] = []
    getOrPrepareRoom.mockImplementation(async () => {
      order.push("prepare")
      return { room: { id: "room-42" }, isNewRoom: true }
    })
    handleUpgrade.mockImplementation((_req, _socket, _head, cb) => {
      order.push("handshake")
      cb(fakeWs())
    })

    await upgradeHandler(upgradeRequest("/api/connect/room-42?sessionId=s1"), fakeSocket(), null)

    expect(order).toEqual(["prepare", "handshake"])
    expect(getOrPrepareRoom).toHaveBeenCalledWith("room-42")
  })

  it("connects the socket to the prepared room", async () => {
    const ws = fakeWs()
    handleUpgrade.mockImplementation((_req, _socket, _head, cb) => cb(ws))
    const room = { id: "room-42" }
    getOrPrepareRoom.mockResolvedValue({ room, isNewRoom: true })

    await upgradeHandler(upgradeRequest("/api/connect/room-42?sessionId=s1"), fakeSocket(), null)

    expect(connectSocket).toHaveBeenCalledWith(room, "room-42", ws, "s1", true)
  })

  it("decodes a roomId containing a slash", async () => {
    await upgradeHandler(upgradeRequest("/api/connect/a/b?sessionId=s1"), fakeSocket(), null)

    expect(getOrPrepareRoom).toHaveBeenCalledWith("a/b")
  })

  it("counts the connection while it is open and releases it on close", async () => {
    const ws = fakeWs()
    handleUpgrade.mockImplementation((_req, _socket, _head, cb) => cb(ws))

    await upgradeHandler(upgradeRequest("/api/connect/room-42?sessionId=s1"), fakeSocket(), null)
    expect(activeConnectionsInc).toHaveBeenCalledTimes(1)
    expect(activeConnectionsDec).not.toHaveBeenCalled()

    ws.emit("close")
    expect(activeConnectionsDec).toHaveBeenCalledTimes(1)
  })

  // The application-level ping is what keeps a Session alive across a load
  // balancer's idle timeout, so it has to keep firing on a quiet connection.
  it("pings an open socket on an interval and stops once it closes", async () => {
    vi.useFakeTimers()
    const ws = fakeWs()
    handleUpgrade.mockImplementation((_req, _socket, _head, cb) => cb(ws))

    await upgradeHandler(upgradeRequest("/api/connect/room-42?sessionId=s1"), fakeSocket(), null)

    vi.advanceTimersByTime(25_000)
    expect(ws.ping).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(25_000)
    expect(ws.ping).toHaveBeenCalledTimes(2)

    ws.emit("close")
    vi.advanceTimersByTime(100_000)
    expect(ws.ping).toHaveBeenCalledTimes(2)
  })

  it("does not ping a socket that is no longer open", async () => {
    vi.useFakeTimers()
    const ws = fakeWs(3)
    handleUpgrade.mockImplementation((_req, _socket, _head, cb) => cb(ws))

    await upgradeHandler(upgradeRequest("/api/connect/room-42?sessionId=s1"), fakeSocket(), null)
    vi.advanceTimersByTime(75_000)

    expect(ws.ping).not.toHaveBeenCalled()
  })

  it("stops pinging when the socket errors", async () => {
    vi.useFakeTimers()
    const ws = fakeWs()
    handleUpgrade.mockImplementation((_req, _socket, _head, cb) => cb(ws))

    await upgradeHandler(upgradeRequest("/api/connect/room-42?sessionId=s1"), fakeSocket(), null)
    ws.emit("error", new Error("boom"))
    vi.advanceTimersByTime(100_000)

    expect(ws.ping).not.toHaveBeenCalled()
  })

  // Losing the race for a Room Lock is an ordinary outcome under contention, not
  // a fault — the client reconnects and lands on the new Room Owner. Logging it
  // as an error would bury the failures that do matter.
  it("refuses the upgrade quietly when the Room Lock cannot be acquired", async () => {
    const socket = fakeSocket()
    getOrPrepareRoom.mockRejectedValue(new Error("LOCK_ACQUISITION_FAILED"))

    await upgradeHandler(upgradeRequest("/api/connect/room-42?sessionId=s1"), socket, null)

    expect(socket.destroy).toHaveBeenCalled()
    expect(errorCounterInc).toHaveBeenCalledWith({ type: "websocket_error" })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it("logs any other preparation failure", async () => {
    const socket = fakeSocket()
    getOrPrepareRoom.mockRejectedValue(new Error("redis is down"))

    await upgradeHandler(upgradeRequest("/api/connect/room-42?sessionId=s1"), socket, null)

    expect(socket.destroy).toHaveBeenCalled()
    expect(errorCounterInc).toHaveBeenCalledWith({ type: "websocket_error" })
    expect(errorSpy).toHaveBeenCalled()
  })

  it("does not leave a connection counted when preparation fails", async () => {
    getOrPrepareRoom.mockRejectedValue(new Error("LOCK_ACQUISITION_FAILED"))

    await upgradeHandler(upgradeRequest("/api/connect/room-42?sessionId=s1"), fakeSocket(), null)

    expect(activeConnectionsInc).not.toHaveBeenCalled()
    expect(connectSocket).not.toHaveBeenCalled()
  })
})

describe("http routes", () => {
  it("registers the endpoints the deployment targets probe and scrape", () => {
    expect([...routes.keys()]).toEqual(
      expect.arrayContaining([
        "GET /api/health",
        "GET /metrics",
        "POST /api/uploads/:uploadId",
        "GET /api/uploads/:uploadId",
        "GET /api/unfurl",
      ]),
    )
  })

  it("answers the health check", () => {
    const res = { status: vi.fn().mockReturnThis(), send: vi.fn() }
    routes.get("GET /api/health")!({}, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.send).toHaveBeenCalledWith("ok")
  })

  it("serves metrics with the registry content type", async () => {
    const res = { setHeader: vi.fn(), send: vi.fn(), status: vi.fn().mockReturnThis() }
    await routes.get("GET /metrics")!({}, res)

    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; version=0.0.4")
    expect(res.send).toHaveBeenCalledWith("# HELP tldraw_active_rooms\n")
  })

  it("returns 500 rather than throwing when the registry fails", async () => {
    metrics.mockRejectedValue(new Error("registry exploded"))
    const res = { setHeader: vi.fn(), send: vi.fn(), status: vi.fn().mockReturnThis() }

    await routes.get("GET /metrics")!({}, res)

    expect(res.status).toHaveBeenCalledWith(500)
  })
})

describe("graceful shutdown", () => {
  // Order matters: stop taking new Sessions first, then persist. Persisting
  // while new Sessions are still arriving would race a Snapshot against edits
  // that landed after it was taken.
  it("stops accepting connections before persisting rooms", async () => {
    const order: string[] = []
    fakeServer.close.mockImplementation((cb?: () => void) => {
      order.push("close")
      cb?.()
      return fakeServer
    })
    shutdown.mockImplementation(async () => {
      order.push("shutdown")
    })

    await exitCodeFrom(signalHandlers.get("SIGTERM")!)

    expect(order).toEqual(["close", "shutdown"])
  })

  it("exits cleanly once every room is persisted and unlocked", async () => {
    shutdown.mockResolvedValue(undefined)

    expect(await exitCodeFrom(signalHandlers.get("SIGTERM")!)).toBe(0)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  // A failure here means Snapshots may not have landed. Exiting non-zero is what
  // tells the platform the instance did not drain cleanly — and it must not go
  // on to report success afterwards.
  it("exits non-zero when persisting rooms fails", async () => {
    shutdown.mockRejectedValue(new Error("gcs unavailable"))

    expect(await exitCodeFrom(signalHandlers.get("SIGTERM")!)).toBe(1)
  })

  it("treats SIGINT the same as SIGTERM", async () => {
    shutdown.mockResolvedValue(undefined)

    expect(await exitCodeFrom(signalHandlers.get("SIGINT")!)).toBe(0)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })
})
