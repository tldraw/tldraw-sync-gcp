import { createServer, type IncomingMessage, type Server } from "http"
import { connect as netConnect } from "net"
import type { Duplex } from "stream"
import { URL } from "url"
import { casOwner, readOwner } from "../registry.js"
import { register, routerResolveDuration, routerRetriesCounter } from "../metrics.js"
import { resolve } from "./resolve.js"
import type { MemberCache } from "./memberCache.js"
import { OwnershipCache, notifyOwnershipLost } from "./ownership.js"

// Shared by both transports: the router answers ownership questions so workers
// do not each have to read the record themselves.
export const ownership = new OwnershipCache()

/**
 * The router's internal HTTP surface, common to proxy and ext_authz mode.
 *
 * Cluster-internal only — neither endpoint is authenticated, and both must stay
 * unreachable from outside. In mode A they sit on the ext_authz port, which
 * Envoy reaches over loopback and nothing else can; in mode B they share the
 * public listener, so a NetworkPolicy is what keeps them private.
 *
 * Returns true when it handled the request.
 */
export function handleInternal(
  request: IncomingMessage,
  response: import("http").ServerResponse,
  cache: MemberCache,
): boolean {
  if (request.method !== "POST" || !request.url?.startsWith("/internal/")) return false

  let body = ""
  request.on("data", (chunk) => (body += chunk))
  request.on("end", async () => {
    let parsed: { addr?: string; roomIds?: string[] } = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      // A malformed push is ignored; the worker's poll is the fallback.
    }

    // Removal-only, by design. A worker may shorten its own removal; nothing
    // here may add a member, because two routers disagreeing about who exists
    // is what reallocates a live worker's Rooms out from under it.
    if (request.url === "/internal/draining") {
      if (parsed.addr) cache.markDraining(parsed.addr)
      response.statusCode = 204
      response.end()
      return
    }

    // "Which of these Rooms have I lost?" -- answered from the router's cache,
    // reading the record only on a miss. This is the query that replaced every
    // worker re-reading every Room it holds, every few seconds.
    if (request.url === "/internal/ownership") {
      if (!parsed.addr || !Array.isArray(parsed.roomIds)) {
        response.statusCode = 400
        response.end()
        return
      }
      try {
        const lost = await ownership.lostBy(parsed.addr, parsed.roomIds)
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ lost }))
      } catch (error) {
        // Fail closed on the answer, not on the Rooms: a 503 tells the worker
        // to keep serving and ask again, rather than to drop anything.
        console.error("[Router] Ownership query failed:", error)
        response.statusCode = 503
        response.end()
      }
      return
    }

    response.statusCode = 404
    response.end()
  })
  return true
}

/**
 * Which worker should this connection go to? Reads the record, resolves, and
 * CASes if the Room is up for allocation. One retry on a lost CAS: re-read and
 * use the winner's answer rather than our own pick.
 */
export async function resolveForConnect(
  roomId: string,
  cache: MemberCache,
): Promise<{ addr: string } | { error: 503 }> {
  const done = routerResolveDuration.startTimer()
  try {
    const record = await readOwner(roomId)
    const live = cache.live()

    let resolution = resolve(roomId, record, live)

    // Only allocation may prefer a reachable worker. Honouring a recorded owner
    // must use the full live set, or a network blip starts moving Rooms.
    if (resolution.action === "claim") {
      const routable = cache.routable()
      if (routable.length > 0) resolution = resolve(roomId, record, routable)
    }

    if (resolution.action === "unavailable") return { error: 503 }
    if (resolution.action === "use") {
      ownership.note(roomId, resolution.addr)
      return { addr: resolution.addr }
    }

    if ((await casOwner(roomId, resolution.expect, resolution.addr)) === "ok") {
      ownership.note(roomId, resolution.addr)
      // We just took this Room from someone. Tell them now rather than letting
      // them find out at their next poll -- they may still be serving it.
      if (record?.owner && record.owner !== resolution.addr) {
        void notifyOwnershipLost(record.owner, roomId)
      }
      return { addr: resolution.addr }
    }

    ownership.invalidate(roomId)
    const winner = await readOwner(roomId)
    if (winner?.owner) {
      ownership.note(roomId, winner.owner)
      return { addr: winner.owner }
    }
    return { error: 503 }
  } catch (error) {
    console.error(`[Router] Failed to resolve room ${roomId}:`, error)
    return { error: 503 }
  } finally {
    done()
  }
}

const roomIdOf = (url: string) =>
  new URL(url, "http://router").pathname.match(/\/api\/connect\/(.+)/)?.[1]

function writeStatus(socket: Duplex, status: number, statusText: string) {
  socket.end(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`)
}

/**
 * Replay the client's upgrade at the owner and splice the two sockets. After
 * the 101 this is byte plumbing in Node's stream path — the router never parses
 * a WebSocket frame, so its cost is per-chunk, not per-edit.
 */
function splice(
  request: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  addr: string,
  cache: MemberCache,
  onRetry: (owner: string) => void,
) {
  const target = new URL(addr)
  const upstream = netConnect({ host: target.hostname, port: Number(target.port || 80) }, () => {
    const headers = Object.entries(request.headers)
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`)
      .join("\r\n")
    upstream.write(`GET ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`)
    if (head.length) upstream.write(head)
  })

  upstream.on("error", () => {
    // A failed dial is a routing signal only: never a CAS, never an eviction.
    cache.markUnreachable(addr)
    if (!clientSocket.destroyed) writeStatus(clientSocket, 503, "Service Unavailable")
  })

  let buffered = Buffer.alloc(0)
  let spliced = false

  upstream.on("data", (chunk: Buffer) => {
    if (spliced) return
    buffered = Buffer.concat([buffered, chunk])
    const headEnd = buffered.indexOf("\r\n\r\n")
    if (headEnd === -1) return

    const responseHead = buffered.subarray(0, headEnd).toString()

    // The worker refused because the record moved between our resolve and its
    // connect. It told us who owns it now; retry there on the same client
    // connection, so the race stays invisible to the client.
    if (responseHead.startsWith("HTTP/1.1 409")) {
      const owner = responseHead.match(/x-room-owner:\s*(\S+)/i)?.[1]
      upstream.destroy()
      if (owner) onRetry(owner)
      else writeStatus(clientSocket, 503, "Service Unavailable")
      return
    }

    spliced = true
    clientSocket.write(buffered)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })

  clientSocket.on("error", () => upstream.destroy())
  upstream.on("close", () => {
    if (spliced) clientSocket.destroy()
  })
}

export function startProxy(cache: MemberCache, port: number): Server {
  const server = createServer(async (request, response) => {
    if (handleInternal(request, response, cache)) return
    if (request.url === "/metrics") {
      response.setHeader("Content-Type", register.contentType)
      response.end(await register.metrics())
      return
    }
    if (request.url === "/api/health") {
      response.end("ok")
      return
    }

    // Plain HTTP needs no affinity: any routable member will do.
    const candidates = cache.routable()
    if (candidates.length === 0) {
      response.statusCode = 503
      response.end("no live workers")
      return
    }
    const target = candidates[Math.floor(Math.random() * candidates.length)].addr
    response.statusCode = 307
    response.setHeader("Location", `${target}${request.url}`)
    response.end()
  })

  server.on("upgrade", async (request, clientSocket, head) => {
    const roomId = request.url ? roomIdOf(request.url) : undefined
    if (!roomId) {
      clientSocket.destroy()
      return
    }

    const resolution = await resolveForConnect(roomId, cache)
    if ("error" in resolution) {
      writeStatus(clientSocket, 503, "Service Unavailable")
      return
    }

    // Bounded to a single retry: the corrected owner is authoritative, and a
    // second bounce would mean the record is moving faster than we can follow.
    splice(request, clientSocket, head, resolution.addr, cache, (owner) => {
      routerRetriesCounter.inc()
      splice(request, clientSocket, head, owner, cache, () =>
        writeStatus(clientSocket, 503, "Service Unavailable"),
      )
    })
  })

  server.listen(port, () => console.log(`[Router] proxy mode listening on ${port}`))
  return server
}
