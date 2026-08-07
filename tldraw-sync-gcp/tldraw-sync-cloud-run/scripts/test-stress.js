import WebSocket from "ws"

// Your GCP Load Balancer URL
const SERVER_URL = "wss://gcp-sync.tldraw.xyz"

// ⚠️ STRESS TEST CONFIGURATION
// Increase these numbers until the server breaks!
const NUM_ROOMS = 10 // Example: 50 active rooms
const USERS_PER_ROOM = 25 // Example: 20 users per room = 1000 connections total

console.log(
  `🔥 Starting STRESS TEST: ${NUM_ROOMS} rooms x ${USERS_PER_ROOM} users = ${
    NUM_ROOMS * USERS_PER_ROOM
  } connections`,
)

const connections = []
let errorCount = 0

// Create rooms
for (let r = 0; r < NUM_ROOMS; r++) {
  const roomId = `stress-room-${r}`

  // Create users for each room
  for (let u = 0; u < USERS_PER_ROOM; u++) {
    // Stagger connections to avoid instant DDoS blocking (spread over 60 seconds)
    const delay = Math.floor(Math.random() * 60000)

    setTimeout(() => {
      connectUser(roomId, `stress-user-${r}-${u}`)
    }, delay)
  }
}

function connectUser(roomId, sessionId) {
  try {
    const ws = new WebSocket(`${SERVER_URL}/api/connect/${roomId}?sessionId=${sessionId}`)

    ws.on("open", () => {
      connections.push(ws)
      // Send random data to simulate active drawing (put load on CPU)
      setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "update", payload: { x: Math.random() } }))
        }
      }, 5000) // Every 5 seconds
    })

    ws.on("error", (err) => {
      errorCount++
      // process.stdout.write('E'); // Log error visually
    })

    ws.on("close", (code) => {
      // 1013 is "Try Again" (Load Balancer redirect), ignore it.
      // Any other code is a potential failure under load.
      if (code !== 1013 && code !== 1000) {
        errorCount++
        console.log(`❌ Disconnected: ${code}`)
      }
    })
  } catch (e) {
    console.error("Critical failure:", e)
  }
}

// Status Report every 5 seconds
setInterval(() => {
  console.log(`\n📊 Status Report:`)
  console.log(`   Active Connections: ${connections.length}`)
  console.log(`   Errors Encountered: ${errorCount}`)

  // Check if we hit a limit
  if (errorCount > 100) {
    console.log("⚠️  HIGH ERROR RATE DETECTED. System may be unstable.")
  }
}, 5000)
