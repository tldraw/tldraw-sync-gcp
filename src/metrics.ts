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

export const handoverRequestsCounter = new client.Counter({
  name: "tldraw_handover_requests_total",
  help: "Total handover requests initiated",
  registers: [register],
})

export const handoverSuccessCounter = new client.Counter({
  name: "tldraw_handover_success_total",
  help: "Successful handovers completed",
  registers: [register],
})

export const handoverTimeoutCounter = new client.Counter({
  name: "tldraw_handover_timeouts_total",
  help: "Handovers that timed out",
  registers: [register],
})

export const handoverDurationHistogram = new client.Histogram({
  name: "tldraw_handover_duration_seconds",
  help: "Time taken for handover coordination",
  buckets: [0.1, 0.5, 1, 2, 5],
  registers: [register],
})
