import { createServer, type Server } from "http"
import { URL } from "url"
import { register } from "../metrics.js"
import type { MemberCache } from "./memberCache.js"
import { handleInternal, resolveForConnect } from "./proxy.js"

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" }

/**
 * Envoy's ORIGINAL_DST header takes host:port and refuses a scheme. The Owner
 * Identity is a full URL, so this is the one place the two representations
 * meet — keep it here rather than letting bare host:port leak into the registry.
 */
export function hostPort(addr: string): string {
  const url = new URL(addr)
  return `${url.hostname}:${url.port || DEFAULT_PORTS[url.protocol] || "80"}`
}

export interface AuthzDecision {
  status: number
  headers?: Record<string, string>
}

/**
 * One call per connection, never per message — which is the property mode A
 * exists for. Envoy does the proxying, so the router holds zero sockets and
 * its cost is O(connects per second).
 */
export async function handleAuthz(url: string, cache: MemberCache): Promise<AuthzDecision> {
  const { pathname } = new URL(url, "http://router")
  const roomId = pathname.match(/\/api\/connect\/(.+)/)?.[1]

  if (roomId) {
    const resolution = await resolveForConnect(roomId, cache)
    if ("error" in resolution) return { status: 503 }
    return { status: 200, headers: { "x-envoy-original-dst-host": hostPort(resolution.addr) } }
  }

  // /api/uploads, /api/unfurl, /api/health, /metrics: no affinity, no bucket
  // read. Naming an upstream here too is what lets Envoy hold exactly one
  // cluster and perform no service discovery at all.
  const candidates = cache.routable()
  if (candidates.length === 0) return { status: 503 }

  const target = candidates[Math.floor(Math.random() * candidates.length)].addr
  return { status: 200, headers: { "x-envoy-original-dst-host": hostPort(target) } }
}

export function startExtAuthz(cache: MemberCache, port: number): Server {
  const server = createServer(async (request, response) => {
    if (handleInternal(request, response, cache)) return
    if (request.url === "/metrics") {
      response.setHeader("Content-Type", register.contentType)
      response.end(await register.metrics())
      return
    }

    const decision = await handleAuthz(request.url ?? "/", cache)
    response.statusCode = decision.status
    for (const [name, value] of Object.entries(decision.headers ?? {})) {
      response.setHeader(name, value)
    }
    response.end()
  })

  server.listen(port, () => console.log(`[Router] ext_authz mode listening on ${port}`))
  return server
}
