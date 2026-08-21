import { MemberCache } from "./memberCache.js"
import { startExtAuthz } from "./extAuthz.js"
import { startProxy } from "./proxy.js"

// One package, two entrypoints: src/index.ts is the worker, this is the router.
// They share registry.ts, so there is one CAS implementation and one install.
//
// The transport differs; the decision does not. Both shells call the same
// resolve() over the same registry, and neither performs service discovery.
const mode = process.env.ROUTER_MODE === "ext-authz" ? "ext-authz" : "proxy"
const port = Number(process.env.PORT || 8080)

const cache = new MemberCache()
cache.start()

const server = mode === "ext-authz" ? startExtAuthz(cache, port) : startProxy(cache, port)

process.on("SIGTERM", () => {
  cache.stop()
  server.close(() => process.exit(0))
})
