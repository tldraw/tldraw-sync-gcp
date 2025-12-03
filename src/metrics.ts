import client from "prom-client";

// Create a Registry to hold our metrics
export const register = new client.Registry();

// Add default metrics (CPU, memory, event loop lag, etc.)
client.collectDefaultMetrics({ register });

// 1. tldraw_active_rooms: Current room count
export const activeRoomsGauge = new client.Gauge({
  name: "tldraw_active_rooms",
  help: "Number of active rooms currently held in memory",
  registers: [register],
});

// 2. tldraw_active_connections: WebSocket connections
export const activeConnectionsGauge = new client.Gauge({
  name: "tldraw_active_connections",
  help: "Number of active WebSocket connections",
  registers: [register],
});

// 3. tldraw_room_latency: Response times (Http Request Duration)
export const httpRequestDurationMicroseconds = new client.Histogram({
  name: "tldraw_room_latency",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "code"],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
  registers: [register],
});

// 4. tldraw_error_rate: Error frequency
export const errorCounter = new client.Counter({
  name: "tldraw_error_rate",
  help: "Total number of errors encountered",
  labelNames: ["type"],
  registers: [register],
});
