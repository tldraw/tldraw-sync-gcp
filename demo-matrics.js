import WebSocket from "ws";

const SERVER_URL = "wss://gcp-sync.tldraw.xyz";

const SCENARIOS = [
  { roomId: "workshop-room-1", userCount: 10 },
  { roomId: "workshop-room-2", userCount: 10 },
  { roomId: "workshop-room-3", userCount: 10 },
];

console.log(`📊 Starting Workshop Demo: 3 Rooms, 30 Users total...`);
console.log(`🔄 Clients will automatically retry if routed to the wrong pod.`);

const connections = [];

SCENARIOS.forEach((scenario, scenarioIndex) => {
  for (let i = 0; i < scenario.userCount; i++) {
    const sessionId = `user-${scenarioIndex}-${i}`;
    const roomUrl = `${SERVER_URL}/api/connect/${scenario.roomId}?sessionId=${sessionId}`;

    connectWithRetry(roomUrl, sessionId);
  }
});

function connectWithRetry(url, sessionId) {
  const ws = new WebSocket(url);

  ws.on("open", () => {
    // Connection success! Keep it alive.
    connections.push(ws);
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }, 30000);
  });

  ws.on("close", (code) => {
    // If rejected (1013), retry immediately
    if (code === 1013) {
      process.stdout.write("."); // Dot means "Retrying..."
      setTimeout(
        () => connectWithRetry(url, sessionId),
        Math.random() * 500 + 200
      );
    } else {
      // Real disconnect
      console.log(`\n⚠️ ${sessionId} disconnected (Code: ${code})`);
    }
  });

  ws.on("error", () => {}); // Silence errors during retry
}

console.log(
  "⏳ Connecting... You will see dots (.) as users find the right server."
);

// Keep process alive
process.stdin.resume();
process.on("SIGINT", () => {
  console.log("\n🛑 Closing connections...");
  connections.forEach((ws) => ws.close());
  process.exit();
});
