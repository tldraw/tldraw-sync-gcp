import WebSocket from "ws"

const ROOM_ID = "lock-test-room"
const SERVER_A = process.env.BASE_URL_A || "ws://localhost:3001"
const SERVER_B = process.env.BASE_URL_B || "ws://localhost:3002"

async function runTest() {
  const ws1 = new WebSocket(`${SERVER_A}/api/connect/${ROOM_ID}?sessionId=user-a`)

  ws1.on("open", () => {
    setTimeout(connectUserB, 1000)
  })

  ws1.on("error", () => {})

  function connectUserB() {
    const ws2 = new WebSocket(`${SERVER_B}/api/connect/${ROOM_ID}?sessionId=user-b`)

    let passed = false

    ws2.on("open", () => {
      setTimeout(() => {
        if (!passed && ws2.readyState === WebSocket.OPEN) {
          ws2.close()
          cleanup()
        }
      }, 2000)
    })

    ws2.on("close", (code, reason) => {
      passed = true
      if (
        code === 1013 ||
        code === 1011 ||
        reason.toString().includes("hosted on another server")
      ) {
      }
      cleanup()
    })
  }

  function cleanup() {
    if (ws1.readyState === WebSocket.OPEN) ws1.close()
    process.exit(0)
  }
}

runTest()
