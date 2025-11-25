import WebSocket from "ws";

const ROOM_ID = "lock-test-room";
const SERVER_A = "ws://localhost:3001";
const SERVER_B = "ws://localhost:3002";

async function runTest() {
  console.log("🧪 --- Starting Distributed Lock Test ---");

  // 1. Connect User A to Server A
  console.log(`\n1. Connecting User A to Server A (${SERVER_A})...`);
  const ws1 = new WebSocket(
    `${SERVER_A}/api/connect/${ROOM_ID}?sessionId=user-a`
  );

  ws1.on("open", () => {
    console.log("✅ User A connected to Server A. (Lock acquired)");
    setTimeout(connectUserB, 1000);
  });

  ws1.on("error", (err) => console.error("❌ Server A error:", err.message));

  // 2. Connect User B to Server B
  function connectUserB() {
    console.log(`\n2. Connecting User B to Server B (${SERVER_B})...`);
    const ws2 = new WebSocket(
      `${SERVER_B}/api/connect/${ROOM_ID}?sessionId=user-b`
    );

    // Flag to track if we pass
    let passed = false;

    ws2.on("open", () => {
      console.log("⚠️  User B connected. Waiting for Server B to reject...");

      // If the connection stays open for more than 2 seconds, THEN it's a failure
      setTimeout(() => {
        if (!passed && ws2.readyState === WebSocket.OPEN) {
          console.log("❌ FAILURE: Server B kept the connection open!");
          ws2.close();
          cleanup();
        }
      }, 2000);
    });

    ws2.on("close", (code, reason) => {
      passed = true;
      // 1013 is "Try Again Later", 1011 is "Internal Error", both mean rejection here
      if (
        code === 1013 ||
        code === 1011 ||
        reason.toString().includes("hosted on another server")
      ) {
        console.log("✅ SUCCESS: User B was rejected by Server B.");
        console.log(`   Reason: "${reason}" (Code: ${code})`);
      } else {
        console.log(`⚠️  User B disconnected with code: ${code}`);
      }
      cleanup();
    });
  }

  function cleanup() {
    console.log("\n--- Test Complete ---");
    if (ws1.readyState === WebSocket.OPEN) ws1.close();
    process.exit(0);
  }
}

runTest();
