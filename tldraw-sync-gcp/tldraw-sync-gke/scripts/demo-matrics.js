import WebSocket from "ws"

const SERVER_URL = "wss://gcp-sync.tldraw.xyz"

const SCENARIOS = [
  { roomId: "workshop-room-1", userCount: 10 },
  { roomId: "workshop-room-2", userCount: 10 },
  { roomId: "workshop-room-3", userCount: 10 },
]

const connections = []

SCENARIOS.forEach((scenario, scenarioIndex) => {
  for (let i = 0; i < scenario.userCount; i++) {
    const sessionId = `user-${scenarioIndex}-${i}`
    const roomUrl = `${SERVER_URL}/api/connect/${scenario.roomId}?sessionId=${sessionId}`

    connectWithRetry(roomUrl, sessionId)
  }
})

function connectWithRetry(url, sessionId) {
  const ws = new WebSocket(url)

  ws.on("open", () => {
    connections.push(ws)
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping()
    }, 30000)
  })

  ws.on("close", (code) => {
    if (code === 1013) {
      setTimeout(() => connectWithRetry(url, sessionId), Math.random() * 500 + 200)
    }
  })

  ws.on("error", () => {})
}

process.stdin.resume()
process.on("SIGINT", () => {
  connections.forEach((ws) => ws.close())
  process.exit()
})
