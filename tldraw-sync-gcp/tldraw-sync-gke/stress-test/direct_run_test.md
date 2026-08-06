docker run --rm -i grafana/k6 run -e BASE_URL=wss://gcp-sync.tldraw.xyz -e ROOMS=100 -e USERS_PER_ROOM=70 - << 'EOF'
import ws from 'k6/ws';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
const ROOMS = parseInt(**ENV.ROOMS) || 100;
const USERS_PER_ROOM = parseInt(**ENV.USERS_PER_ROOM) || 70;
const BASE_URL = **ENV.BASE_URL || 'wss://gcp-sync.tldraw.xyz';
const DRAW_INTERVAL_MS = parseInt(**ENV.DRAW_INTERVAL) || 2000;
// Connection metrics
const wsConnectTime = new Trend('ws_connect_time', true);
const wsFailed = new Counter('ws_failed');
const wsSuccess = new Counter('ws_success');
const wsSuccessRate = new Rate('ws_success_rate');
// Message latency metrics
const wsFirstMsgLatency = new Trend('ws_first_msg_latency', true);
const wsInterMsgLatency = new Trend('ws_inter_msg_latency', true);
const wsMessagesReceived = new Counter('ws_messages_received');
const wsMessagesSent = new Counter('ws_messages_sent');
// Drawing simulation metrics
const drawLatency = new Trend('draw_broadcast_latency', true);
export const options = {
scenarios: {
stress: {
executor: 'ramping-vus',
startVUs: 0,
stages: [
{ duration: '2m', target: ROOMS * USERS_PER_ROOM },
{ duration: '3m', target: ROOMS * USERS_PER_ROOM },
{ duration: '30s', target: 0 },
],
},
},
summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};
// Generate a tldraw-like shape update message
function generateDrawMessage(shapeId, x, y) {
return JSON.stringify({
type: 'push',
clientClock: Date.now(),
diff: {
[`shape:${shapeId}`]: {
id: `shape:${shapeId}`,
type: 'draw',
x: x,
y: y,
props: {
segments: [{ type: 'free', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }],
color: 'black',
size: 'm',
},
},
},
});
}
export default function () {
const vuId = **VU;
const roomIndex = Math.floor(vuId / USERS_PER_ROOM) % ROOMS;
const userIndexInRoom = vuId % USERS_PER_ROOM;
const roomId = `room-${roomIndex}`;
const sessionId = `stress-${vuId}-${**ITER}`;
const url = `${BASE_URL}/api/connect/${roomId}?sessionId=${sessionId}`;

// First 5 users in each room are "drawers" who send updates
const isDrawer = userIndexInRoom < 5;

const connectStart = Date.now();
let connectionEstablished = 0;
let firstMessage = true;
let lastMsgTime = 0;
let msgCount = 0;

const res = ws.connect(url, { tags: { name: 'ws' } }, (socket) => {
const connectTime = Date.now() - connectStart;
connectionEstablished = Date.now();
wsConnectTime.add(connectTime);
wsSuccess.add(1);
wsSuccessRate.add(1);
lastMsgTime = Date.now();

    socket.on('message', (data) => {
      const now = Date.now();
      msgCount++;
      wsMessagesReceived.add(1);

      if (firstMessage) {
        // Time from connection established to first server message
        wsFirstMsgLatency.add(now - connectionEstablished);
        firstMessage = false;
      } else {
        // Time between consecutive messages (sync broadcast latency)
        const interMsgTime = now - lastMsgTime;
        wsInterMsgLatency.add(interMsgTime);

        // If we receive messages frequently, it indicates active sync
        if (interMsgTime < 5000) {
          drawLatency.add(interMsgTime);
        }
      }
      lastMsgTime = now;
    });

    // Drawers send periodic updates to simulate drawing
    if (isDrawer) {
      let drawCount = 0;
      socket.setInterval(() => {
        if (socket.readyState === 1) {
          const shapeId = `${sessionId}-${drawCount}`;
          const msg = generateDrawMessage(shapeId, drawCount * 10, drawCount * 10);
          socket.send(msg);
          wsMessagesSent.add(1);
          drawCount++;
        }
      }, DRAW_INTERVAL_MS);
    }

    socket.setTimeout(() => socket.close(), 30000);

});

const connected = check(res, { 'connected': (r) => r && r.status === 101 });
if (!connected) {
wsFailed.add(1);
wsSuccessRate.add(0);
}
}
export function handleSummary(data) {
const m = data.metrics;
const get = (name, stat) => {
if (!m[name] || !m[name].values) return 'N/A';
const v = m[name].values[stat];
return typeof v === 'number' ? v.toFixed(2) : 'N/A';
};

const summary = `╔════════════════════════════════════════════════════════════════════════════╗
║                    TLDRAW SYNC STRESS TEST - FULL RESULTS                  ║
╠════════════════════════════════════════════════════════════════════════════╣
║  CONFIGURATION                                                             ║
║    Target:              ${BASE_URL.padEnd(52)}║
║    Rooms:               ${String(ROOMS).padEnd(52)}║
║    Users/Room:          ${String(USERS_PER_ROOM).padEnd(52)}║
║    Total VUs:           ${String(ROOMS * USERS_PER_ROOM).padEnd(52)}║
║    Drawers/Room:        5                                                  ║
╠════════════════════════════════════════════════════════════════════════════╣
║  CONNECTION RESULTS                                                        ║
║    Successful:          ${get('ws_success', 'count').padEnd(52)}║
║    Failed:              ${get('ws_failed', 'count').padEnd(52)}║
║    Success Rate:        ${(get('ws_success_rate', 'rate') * 100).toFixed(2).padEnd(49)}%║
╠════════════════════════════════════════════════════════════════════════════╣
║  CONNECTION LATENCY                                                        ║
║    Average:             ${(get('ws_connect_time', 'avg') + 'ms').padEnd(52)}║
║    Median (p50):        ${(get('ws_connect_time', 'med') + 'ms').padEnd(52)}║
║    p(95):               ${(get('ws_connect_time', 'p(95)') + 'ms').padEnd(52)}║
║    p(99):               ${(get('ws_connect_time', 'p(99)') + 'ms').padEnd(52)}║
║    Min:                 ${(get('ws_connect_time', 'min') + 'ms').padEnd(52)}║
║    Max:                 ${(get('ws_connect_time', 'max') + 'ms').padEnd(52)}║
╠════════════════════════════════════════════════════════════════════════════╣
║  MESSAGE LATENCY                                                           ║
║    First Message:       ${(get('ws_first_msg_latency', 'avg') + 'ms avg').padEnd(52)}║
║    Inter-Message:       ${(get('ws_inter_msg_latency', 'avg') + 'ms avg').padEnd(52)}║
║    Inter-Message p(95): ${(get('ws_inter_msg_latency', 'p(95)') + 'ms').padEnd(52)}║
║    Broadcast Latency:   ${(get('draw_broadcast_latency', 'avg') + 'ms avg').padEnd(52)}║
║    Broadcast p(95):     ${(get('draw_broadcast_latency', 'p(95)') + 'ms').padEnd(52)}║
╠════════════════════════════════════════════════════════════════════════════╣
║  THROUGHPUT                                                                ║
║    Messages Sent:       ${get('ws_messages_sent', 'count').padEnd(52)}║
║    Messages Received:   ${get('ws_messages_received', 'count').padEnd(52)}║
╚════════════════════════════════════════════════════════════════════════════╝`;

return {
stdout: summary,
};
}
EOF
