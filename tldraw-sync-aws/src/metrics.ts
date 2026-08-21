import client from "prom-client"

export const register = new client.Registry()

client.collectDefaultMetrics({ register })

export const activeRoomsGauge = new client.Gauge({
  name: "tldraw_active_rooms",
  help: "Number of active rooms currently held in memory",
  registers: [register],
})

export const activeConnectionsGauge = new client.Gauge({
  name: "tldraw_active_connections",
  help: "Number of active WebSocket connections",
  registers: [register],
})

export const httpRequestDurationMicroseconds = new client.Histogram({
  name: "tldraw_room_latency",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "code"],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
  registers: [register],
})

export const errorCounter = new client.Counter({
  name: "tldraw_error_rate",
  help: "Total number of errors encountered",
  labelNames: ["type"],
  registers: [register],
})

// --- Ownership (worker) ---

export const roomClaimsCounter = new client.Counter({
  name: "tldraw_room_claims_total",
  help: "Rooms claimed that had no ownership record at all",
  registers: [register],
})

export const roomReclaimsCounter = new client.Counter({
  name: "tldraw_room_reclaims_total",
  help: "Rooms reallocated from a dead or drained owner",
  registers: [register],
})

export const roomCasConflictsCounter = new client.Counter({
  name: "tldraw_room_cas_conflicts_total",
  help: "Conditional writes that lost the race and were re-read",
  registers: [register],
})

export const roomOwnershipLostCounter = new client.Counter({
  name: "tldraw_room_ownership_lost_total",
  help: "Rooms given up because the record no longer named this worker",
  registers: [register],
})

// --- Routing (router) ---

export const membersLiveGauge = new client.Gauge({
  name: "tldraw_members_live",
  help: "Workers currently inside MEMBER_TTL, as seen by this router",
  registers: [register],
})

export const routerResolveDuration = new client.Histogram({
  name: "tldraw_router_resolve_duration_seconds",
  help: "Time to answer which worker owns a room, including any CAS",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
})

export const routerRetriesCounter = new client.Counter({
  name: "tldraw_router_retries_total",
  help: "Connections retried against a corrected owner after a 409",
  registers: [register],
})
