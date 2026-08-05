import ws from "k6/ws"
import { check, sleep } from "k6"
import { Counter, Trend, Gauge } from "k6/metrics"
import { randomString } from "https://jslib.k6.io/k6-utils/1.2.0/index.js"
import { htmlReport } from "https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js"
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js"

const CONFIG = {
  baseUrl: __ENV.BASE_URL || "ws://localhost:3001",
  totalRooms: parseInt(__ENV.ROOMS) || 100,
  usersPerRoom: parseInt(__ENV.USERS_PER_ROOM) || 100,
  connectionDuration: __ENV.DURATION || "5m",
  rampUpDuration: __ENV.RAMP_UP || "2m",
  activityIntervalMs: parseInt(__ENV.ACTIVITY_INTERVAL) || 5000,
  simulateDrawing: __ENV.SIMULATE_DRAWING !== "false",
}

const TOTAL_VUS = CONFIG.totalRooms * CONFIG.usersPerRoom

const wsConnectTime = new Trend("ws_connect_time", true)
const wsMessageLatency = new Trend("ws_message_latency", true)
const wsConnectionsActive = new Gauge("ws_connections_active")
const wsConnectionsFailed = new Counter("ws_connections_failed")
const wsConnectionsSuccess = new Counter("ws_connections_success")
const wsMessagesReceived = new Counter("ws_messages_received")
const wsMessagesSent = new Counter("ws_messages_sent")
const wsReconnects = new Counter("ws_reconnects")
const ws1013RoomMigration = new Counter("ws_1013_room_migration")
const ws1005IdleTimeout = new Counter("ws_1005_idle_timeout")
const wsOtherErrors = new Counter("ws_other_errors")
const handoverEvents = new Counter("handover_events")

export const options = {
  scenarios: {
    websocket_stress: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: CONFIG.rampUpDuration, target: TOTAL_VUS },
        { duration: CONFIG.connectionDuration, target: TOTAL_VUS },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    ws_connect_time: ["p(95)<10000"],
    ws_connections_failed: ["count<500"],
    checks: ["rate>0.95"],
  },
}

const roomIds = []

function initRoomIds() {
  if (roomIds.length === 0) {
    for (let i = 0; i < CONFIG.totalRooms; i++) {
      roomIds.push(generateRoomId())
    }
  }
}

function generateRoomId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const segments = [6, 3, 10]
  return segments
    .map((len) => {
      let s = ""
      for (let i = 0; i < len; i++) {
        s += chars.charAt(Math.floor(Math.random() * chars.length))
      }
      return s
    })
    .join("-")
}

function getRoomId(vuId) {
  initRoomIds()
  const roomIndex = Math.floor(vuId / CONFIG.usersPerRoom) % roomIds.length
  return roomIds[roomIndex]
}

function generateSessionId() {
  return `stress-user-${randomString(12)}`
}

function generateTldrawMessage() {
  return JSON.stringify({
    type: "push",
    clientClock: Date.now(),
    diff: {},
  })
}

function parseDuration(duration) {
  const match = duration.match(/^(\d+)(s|m|h)$/)
  if (!match) return 300000

  const value = parseInt(match[1])
  const unit = match[2]

  switch (unit) {
    case "s":
      return value * 1000
    case "m":
      return value * 60 * 1000
    case "h":
      return value * 60 * 60 * 1000
    default:
      return 300000
  }
}

export default function () {
  const vuId = __VU
  const roomId = getRoomId(vuId)
  const sessionId = generateSessionId()
  const url = `${CONFIG.baseUrl}/api/connect/${roomId}?sessionId=${sessionId}`

  let connectStart = Date.now()
  let reconnectAttempts = 0
  const maxReconnects = 10

  function connect() {
    connectStart = Date.now()

    const res = ws.connect(url, { tags: { name: "WebSocketConnection" } }, function (socket) {
      const connectTime = Date.now() - connectStart
      wsConnectTime.add(connectTime)
      wsConnectionsSuccess.add(1)
      wsConnectionsActive.add(1)

      let lastMessageTime = Date.now()
      let messageCount = 0

      socket.on("open", function () {
        reconnectAttempts = 0
      })

      socket.on("message", function (data) {
        const now = Date.now()
        const latency = now - lastMessageTime
        lastMessageTime = now

        wsMessagesReceived.add(1)
        messageCount++

        if (messageCount > 1) {
          wsMessageLatency.add(latency)
        }

        try {
          const msg = JSON.parse(data)
          if (msg.type === "error") {
            wsOtherErrors.add(1)
          }
        } catch (e) {}
      })

      socket.on("close", function (code) {
        wsConnectionsActive.add(-1)

        if (code === 1013) {
          ws1013RoomMigration.add(1)
          handoverEvents.add(1)
        } else if (code === 1005) {
          ws1005IdleTimeout.add(1)
        } else if (code !== 1000 && code !== 1001) {
          wsOtherErrors.add(1)
        }
      })

      socket.on("error", function () {
        wsOtherErrors.add(1)
      })

      if (CONFIG.simulateDrawing) {
        socket.setInterval(function () {
          if (socket.readyState === 1) {
            socket.send(generateTldrawMessage())
            wsMessagesSent.add(1)
          }
        }, CONFIG.activityIntervalMs)
      }

      socket.setTimeout(function () {
        socket.close(1000)
      }, parseDuration(CONFIG.connectionDuration))
    })

    const connected = check(res, {
      "WebSocket connected": (r) => r && r.status === 101,
    })

    if (!connected) {
      wsConnectionsFailed.add(1)

      if (reconnectAttempts < maxReconnects) {
        reconnectAttempts++
        wsReconnects.add(1)
        sleep(1 + Math.random() * 2)
        connect()
      }
    }
  }

  connect()
}

export function setup() {
  const startTime = new Date().toISOString()

  initRoomIds()

  console.log("=".repeat(70))
  console.log("TLDRAW SYNC STRESS TEST")
  console.log("=".repeat(70))
  console.log(`Start Time: ${startTime}`)
  console.log(`Target: ${CONFIG.baseUrl}`)
  console.log(`Rooms: ${CONFIG.totalRooms}`)
  console.log(`Users per room: ${CONFIG.usersPerRoom}`)
  console.log(`Total connections: ${TOTAL_VUS}`)
  console.log(`Ramp-up: ${CONFIG.rampUpDuration}`)
  console.log(`Duration: ${CONFIG.connectionDuration}`)
  console.log("")
  console.log("Sample Room IDs (random, like real client):")
  for (let i = 0; i < Math.min(5, roomIds.length); i++) {
    console.log(`  Room ${i}: ${roomIds[i]}`)
  }
  console.log("=".repeat(70))

  return {
    startTime,
    config: CONFIG,
    totalVUs: TOTAL_VUS,
  }
}

export function teardown(data) {
  const endTime = new Date().toISOString()
  console.log("=".repeat(70))
  console.log(`End Time: ${endTime}`)
  console.log("=".repeat(70))
}

export function handleSummary(data) {
  const reportName = __ENV.REPORT_PREFIX || `stress-test-${Date.now()}`

  const result = {
    [`/reports/${reportName}-summary.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: " ", enableColors: true }) + generateCustomSummary(data),
  }

  try {
    result[`/reports/${reportName}.html`] = htmlReport(data)
  } catch (e) {
    console.log(`Note: HTML report generation skipped (${e.message})`)
    result[`/reports/${reportName}.html`] = generateBasicHtmlReport(data)
  }

  return result
}

function generateBasicHtmlReport(data) {
  const metrics = data.metrics || {}
  const getValue = (name, stat) => {
    if (!metrics[name] || !metrics[name].values) return "N/A"
    const val = metrics[name].values[stat]
    return typeof val === "number" ? val.toFixed(2) : val || "N/A"
  }

  return `<!DOCTYPE html>
<html>
<head>
  <title>k6 Stress Test Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #7c3aed; }
    .card { background: #16213e; border-radius: 8px; padding: 20px; margin: 20px 0; }
    .metric { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #333; }
    .metric:last-child { border-bottom: none; }
    .label { color: #888; }
    .value { font-weight: bold; color: #4ade80; }
    .value.error { color: #f87171; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 12px; border-bottom: 1px solid #333; }
    th { color: #7c3aed; }
  </style>
</head>
<body>
  <h1>Stress Test Report</h1>
  <p>Generated: ${new Date().toISOString()}</p>
  
  <div class="card">
    <h2>Configuration</h2>
    <div class="metric"><span class="label">Target</span><span class="value">${CONFIG.baseUrl}</span></div>
    <div class="metric"><span class="label">Rooms</span><span class="value">${CONFIG.totalRooms}</span></div>
    <div class="metric"><span class="label">Users/Room</span><span class="value">${CONFIG.usersPerRoom}</span></div>
    <div class="metric"><span class="label">Total VUs</span><span class="value">${TOTAL_VUS}</span></div>
    <div class="metric"><span class="label">Duration</span><span class="value">${CONFIG.connectionDuration}</span></div>
  </div>
  
  <div class="card">
    <h2>Connection Metrics</h2>
    <div class="metric"><span class="label">Successful Connections</span><span class="value">${getValue("ws_connections_success", "count")}</span></div>
    <div class="metric"><span class="label">Failed Connections</span><span class="value error">${getValue("ws_connections_failed", "count")}</span></div>
    <div class="metric"><span class="label">Reconnects</span><span class="value">${getValue("ws_reconnects", "count")}</span></div>
  </div>
  
  <div class="card">
    <h2>Latency (Connect Time)</h2>
    <div class="metric"><span class="label">Average</span><span class="value">${getValue("ws_connect_time", "avg")}ms</span></div>
    <div class="metric"><span class="label">p(50)</span><span class="value">${getValue("ws_connect_time", "med")}ms</span></div>
    <div class="metric"><span class="label">p(95)</span><span class="value">${getValue("ws_connect_time", "p(95)")}ms</span></div>
    <div class="metric"><span class="label">Max</span><span class="value">${getValue("ws_connect_time", "max")}ms</span></div>
  </div>
  
  <div class="card">
    <h2>Handover Events</h2>
    <div class="metric"><span class="label">Room Migrations (1013)</span><span class="value">${getValue("ws_1013_room_migration", "count")}</span></div>
    <div class="metric"><span class="label">Idle Timeouts (1005)</span><span class="value">${getValue("ws_1005_idle_timeout", "count")}</span></div>
    <div class="metric"><span class="label">Other Errors</span><span class="value error">${getValue("ws_other_errors", "count")}</span></div>
  </div>
  
  <div class="card">
    <h2>Throughput</h2>
    <div class="metric"><span class="label">Messages Sent</span><span class="value">${getValue("ws_messages_sent", "count")}</span></div>
    <div class="metric"><span class="label">Messages Received</span><span class="value">${getValue("ws_messages_received", "count")}</span></div>
  </div>
</body>
</html>`
}

function generateCustomSummary(data) {
  const metrics = data.metrics

  const getValue = (name, stat) => {
    if (!metrics[name] || !metrics[name].values) return "N/A"
    return metrics[name].values[stat] || 0
  }

  const formatMs = (val) => (typeof val === "number" ? `${val.toFixed(0)}ms` : val)
  const formatCount = (val) => (typeof val === "number" ? val.toLocaleString() : val)

  return `
╔══════════════════════════════════════════════════════════════════════╗
║                    TLDRAW SYNC STRESS TEST SUMMARY                    ║
╠══════════════════════════════════════════════════════════════════════╣
║  CONFIGURATION                                                        ║
║    Target:           ${CONFIG.baseUrl.padEnd(47)}║
║    Rooms:            ${String(CONFIG.totalRooms).padEnd(47)}║
║    Users/Room:       ${String(CONFIG.usersPerRoom).padEnd(47)}║
║    Total VUs:        ${String(TOTAL_VUS).padEnd(47)}║
╠══════════════════════════════════════════════════════════════════════╣
║  CONNECTION METRICS                                                   ║
║    Successful:       ${formatCount(getValue("ws_connections_success", "count")).padEnd(47)}║
║    Failed:           ${formatCount(getValue("ws_connections_failed", "count")).padEnd(47)}║
║    Reconnects:       ${formatCount(getValue("ws_reconnects", "count")).padEnd(47)}║
╠══════════════════════════════════════════════════════════════════════╣
║  LATENCY (connect time)                                               ║
║    Average:          ${formatMs(getValue("ws_connect_time", "avg")).padEnd(47)}║
║    p(50):            ${formatMs(getValue("ws_connect_time", "med")).padEnd(47)}║
║    p(95):            ${formatMs(getValue("ws_connect_time", "p(95)")).padEnd(47)}║
║    Max:              ${formatMs(getValue("ws_connect_time", "max")).padEnd(47)}║
╠══════════════════════════════════════════════════════════════════════╣
║  HANDOVER / MIGRATION EVENTS                                          ║
║    Room Migrations (1013):  ${formatCount(getValue("ws_1013_room_migration", "count")).padEnd(40)}║
║    Idle Timeouts (1005):    ${formatCount(getValue("ws_1005_idle_timeout", "count")).padEnd(40)}║
║    Other Errors:            ${formatCount(getValue("ws_other_errors", "count")).padEnd(40)}║
╠══════════════════════════════════════════════════════════════════════╣
║  THROUGHPUT                                                           ║
║    Messages Sent:    ${formatCount(getValue("ws_messages_sent", "count")).padEnd(47)}║
║    Messages Recv:    ${formatCount(getValue("ws_messages_received", "count")).padEnd(47)}║
╚══════════════════════════════════════════════════════════════════════╝
`
}
