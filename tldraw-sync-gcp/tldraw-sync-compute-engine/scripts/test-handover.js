/**
 * Integration test for the coordinated handover mechanism.
 *
 * This test simulates the scale-up scenario where a new pod receives
 * a connection for a room owned by another pod.
 *
 * Test scenarios:
 * 1. First connection establishes room ownership
 * 2. Simulated "wrong pod" connection triggers handover
 * 3. Handover completes and second connection succeeds
 *
 * Usage:
 *   node test-handover.js [server-url]
 *
 * Example:
 *   node test-handover.js ws://localhost:3001
 *   node test-handover.js wss://gcp-sync.tldraw.xyz
 */

import WebSocket from "ws"

const SERVER_URL = process.argv[2] || "ws://localhost:3001"
const ROOM_ID = `handover-test-${Date.now()}`
const TIMEOUT_MS = 10000

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
}

function log(color, prefix, message) {
  console.log(`${color}[${prefix}]${colors.reset} ${message}`)
}

function createConnection(sessionId) {
  return new Promise((resolve, reject) => {
    const url = `${SERVER_URL}/api/connect/${ROOM_ID}?sessionId=${sessionId}`
    log(colors.blue, "CONNECT", `${sessionId} connecting to ${url}`)

    const ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`Connection timeout for ${sessionId}`))
    }, TIMEOUT_MS)

    ws.on("open", () => {
      clearTimeout(timeout)
      log(colors.green, "OPEN", `${sessionId} connected successfully`)
      resolve({ ws, code: null, reason: null })
    })

    ws.on("close", (code, reason) => {
      clearTimeout(timeout)
      const reasonStr = reason?.toString() || ""
      log(colors.yellow, "CLOSE", `${sessionId} closed with code=${code} reason="${reasonStr}"`)
      resolve({ ws: null, code, reason: reasonStr })
    })

    ws.on("error", (err) => {
      clearTimeout(timeout)
      log(colors.red, "ERROR", `${sessionId} error: ${err.message}`)
      reject(err)
    })
  })
}

async function runHandoverTest() {
  console.log("\n" + "=".repeat(60))
  console.log("HANDOVER INTEGRATION TEST")
  console.log("=".repeat(60))
  console.log(`Server: ${SERVER_URL}`)
  console.log(`Room: ${ROOM_ID}`)
  console.log("=".repeat(60) + "\n")

  let user1Connection = null
  let testPassed = false

  try {
    log(colors.blue, "TEST", "Step 1: First user establishes room ownership")
    const result1 = await createConnection("user-1")

    if (!result1.ws) {
      throw new Error(`User 1 failed to connect: code=${result1.code}`)
    }
    user1Connection = result1.ws
    log(colors.green, "TEST", "User 1 owns the room\n")

    await new Promise((r) => setTimeout(r, 1000))

    log(
      colors.blue,
      "TEST",
      "Step 2: Second user connects (simulates routing to different pod after scale-up)",
    )
    log(
      colors.blue,
      "TEST",
      "If handover works, connection should succeed after brief coordination\n",
    )

    const result2 = await createConnection("user-2")

    if (result2.ws) {
      log(colors.green, "TEST", "User 2 connected successfully!")
      log(colors.green, "PASS", "Handover mechanism working - both users connected to same room\n")
      result2.ws.close()
      testPassed = true
    } else if (result2.code === 1013) {
      log(colors.yellow, "TEST", "User 2 received 1013 (retry needed)")
      log(colors.yellow, "INFO", "This indicates handover was triggered but client needs to retry")
      log(colors.blue, "TEST", "Retrying connection...\n")

      await new Promise((r) => setTimeout(r, 2000))

      const result3 = await createConnection("user-2-retry")
      if (result3.ws) {
        log(colors.green, "PASS", "User 2 connected on retry - handover completed successfully\n")
        result3.ws.close()
        testPassed = true
      } else {
        log(colors.red, "FAIL", `User 2 failed on retry: code=${result3.code}\n`)
      }
    } else {
      log(colors.red, "FAIL", `Unexpected close code: ${result2.code}\n`)
    }
  } catch (err) {
    log(colors.red, "ERROR", err.message)
  } finally {
    if (user1Connection && user1Connection.readyState === WebSocket.OPEN) {
      user1Connection.close()
    }
  }

  console.log("=".repeat(60))
  if (testPassed) {
    log(colors.green, "RESULT", "TEST PASSED")
  } else {
    log(colors.red, "RESULT", "TEST FAILED")
  }
  console.log("=".repeat(60) + "\n")

  process.exit(testPassed ? 0 : 1)
}

async function runConcurrentConnectionTest() {
  console.log("\n" + "=".repeat(60))
  console.log("CONCURRENT CONNECTION TEST")
  console.log("=".repeat(60) + "\n")

  const roomId = `concurrent-test-${Date.now()}`
  const connections = []
  let successCount = 0

  log(colors.blue, "TEST", "Connecting 5 users simultaneously to same room")

  const promises = []
  for (let i = 1; i <= 5; i++) {
    const url = `${SERVER_URL}/api/connect/${roomId}?sessionId=concurrent-user-${i}`
    promises.push(
      new Promise((resolve) => {
        const ws = new WebSocket(url)
        ws.on("open", () => {
          successCount++
          connections.push(ws)
          resolve({ success: true, user: i })
        })
        ws.on("close", (code) => {
          resolve({ success: false, user: i, code })
        })
        ws.on("error", () => {
          resolve({ success: false, user: i, error: true })
        })
      }),
    )
  }

  await Promise.all(promises)

  log(colors.blue, "RESULT", `${successCount}/5 users connected successfully`)

  connections.forEach((ws) => ws.close())

  const passed = successCount >= 4
  if (passed) {
    log(colors.green, "PASS", "Concurrent connections handled correctly\n")
  } else {
    log(colors.red, "FAIL", "Too many connection failures\n")
  }

  return passed
}

async function main() {
  const handoverPassed = await runHandoverTest().catch(() => false)

  await new Promise((r) => setTimeout(r, 2000))

  const concurrentPassed = await runConcurrentConnectionTest().catch(() => false)

  console.log("\n" + "=".repeat(60))
  console.log("FINAL RESULTS")
  console.log("=".repeat(60))
  console.log(`Handover Test: ${handoverPassed ? "PASSED" : "FAILED"}`)
  console.log(`Concurrent Test: ${concurrentPassed ? "PASSED" : "FAILED"}`)
  console.log("=".repeat(60) + "\n")

  process.exit(handoverPassed && concurrentPassed ? 0 : 1)
}

main()
