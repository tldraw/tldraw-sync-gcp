import { beforeEach, describe, expect, it, vi } from "vitest"

const resolveForConnect = vi.fn()
vi.mock("../src/router/proxy.js", () => ({ resolveForConnect }))
vi.mock("../src/metrics.js", () => ({
  register: { contentType: "text/plain", metrics: async () => "" },
}))
vi.mock("../src/router/memberCache.js", () => ({ MemberCache: class {} }))

const { hostPort, handleAuthz } = await import("../src/router/extAuthz.js")

beforeEach(() => resolveForConnect.mockReset())

describe("hostPort", () => {
  it("strips the scheme, because Envoy wants host:port", () => {
    expect(hostPort("http://10.0.1.7:3001")).toBe("10.0.1.7:3001")
  })

  it("defaults the port when the URL omits it", () => {
    expect(hostPort("http://worker.internal")).toBe("worker.internal:80")
  })

  it("defaults an https URL to 443", () => {
    expect(hostPort("https://sync-3-xyz.run.app")).toBe("sync-3-xyz.run.app:443")
  })
})

describe("handleAuthz", () => {
  const cache = { routable: () => [{ addr: "http://10.0.1.9:3001" }] } as never

  it("allows an affinity route and names the owner as host:port", async () => {
    resolveForConnect.mockResolvedValueOnce({ addr: "http://10.0.1.7:3001" })
    expect(await handleAuthz("/api/connect/room-1?sessionId=s1", cache)).toEqual({
      status: 200,
      headers: { "x-envoy-original-dst-host": "10.0.1.7:3001" },
    })
  })

  it("fails closed with 503 when the room cannot be resolved", async () => {
    resolveForConnect.mockResolvedValueOnce({ error: 503 })
    expect(await handleAuthz("/api/connect/room-1", cache)).toMatchObject({ status: 503 })
  })

  it("resolves a non-affinity route to any routable member, with no bucket read", async () => {
    expect(await handleAuthz("/api/unfurl?url=x", cache)).toEqual({
      status: 200,
      headers: { "x-envoy-original-dst-host": "10.0.1.9:3001" },
    })
    expect(resolveForConnect).not.toHaveBeenCalled()
  })

  it("fails closed on a non-affinity route when nothing is routable", async () => {
    const empty = { routable: () => [] } as never
    expect(await handleAuthz("/metrics", empty)).toMatchObject({ status: 503 })
  })
})
