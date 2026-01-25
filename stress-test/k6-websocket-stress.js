import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate, Gauge } from 'k6/metrics';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

const CONFIG = {
  baseUrl: __ENV.BASE_URL || 'ws://localhost:3001',
  totalRooms: parseInt(__ENV.ROOMS) || 100,
  usersPerRoom: parseInt(__ENV.USERS_PER_ROOM) || 100,
  connectionDuration: __ENV.DURATION || '5m',
  rampUpDuration: __ENV.RAMP_UP || '2m',
  activityIntervalMs: parseInt(__ENV.ACTIVITY_INTERVAL) || 5000,
  simulateDrawing: __ENV.SIMULATE_DRAWING !== 'false',
};

const TOTAL_VUS = CONFIG.totalRooms * CONFIG.usersPerRoom;

const wsConnectTime = new Trend('ws_connect_time', true);
const wsMessageLatency = new Trend('ws_message_latency', true);
const wsConnectionsActive = new Gauge('ws_connections_active');
const wsConnectionsFailed = new Counter('ws_connections_failed');
const wsConnectionsSuccess = new Counter('ws_connections_success');
const wsMessagesReceived = new Counter('ws_messages_received');
const wsMessagesSent = new Counter('ws_messages_sent');
const wsReconnects = new Counter('ws_reconnects');
const ws1013Errors = new Counter('ws_1013_room_migration');
const wsErrors = new Counter('ws_errors');
const handoverEvents = new Counter('handover_events');

export const options = {
  scenarios: {
    websocket_stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: CONFIG.rampUpDuration, target: TOTAL_VUS },
        { duration: CONFIG.connectionDuration, target: TOTAL_VUS },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    'ws_connect_time': ['p(95)<5000'],
    'ws_connections_failed': ['count<100'],
    'ws_1013_room_migration': ['count<1000'],
  },
};

function getRoomId(vuId) {
  return `stress-room-${Math.floor(vuId / CONFIG.usersPerRoom)}`;
}

function generateSessionId() {
  return `stress-user-${randomString(12)}`;
}

function generateTldrawMessage() {
  return JSON.stringify({
    type: 'push',
    clientClock: Date.now(),
    diff: {},
  });
}

function parseDuration(duration) {
  const match = duration.match(/^(\d+)(s|m|h)$/);
  if (!match) return 300000;
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: return 300000;
  }
}

export default function () {
  const vuId = __VU;
  const roomId = getRoomId(vuId);
  const sessionId = generateSessionId();
  const url = `${CONFIG.baseUrl}/api/connect/${roomId}?sessionId=${sessionId}`;
  
  let connectStart = Date.now();
  let reconnectAttempts = 0;
  const maxReconnects = 5;
  
  function connect() {
    connectStart = Date.now();
    
    const res = ws.connect(url, {}, function (socket) {
      const connectTime = Date.now() - connectStart;
      wsConnectTime.add(connectTime);
      wsConnectionsSuccess.add(1);
      wsConnectionsActive.add(1);
      
      let lastMessageTime = Date.now();
      let messageCount = 0;
      
      socket.on('open', function () {
        console.log(`[VU ${vuId}] Connected to room ${roomId} in ${connectTime}ms`);
        reconnectAttempts = 0;
      });
      
      socket.on('message', function (data) {
        const now = Date.now();
        const latency = now - lastMessageTime;
        lastMessageTime = now;
        
        wsMessagesReceived.add(1);
        messageCount++;
        
        if (messageCount > 1) {
          wsMessageLatency.add(latency);
        }
        
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'error') {
            wsErrors.add(1);
            console.log(`[VU ${vuId}] Error message: ${data}`);
          }
        } catch (e) {
        }
      });
      
      socket.on('close', function (code, reason) {
        wsConnectionsActive.add(-1);
        console.log(`[VU ${vuId}] Disconnected: ${code} - ${reason}`);
        
        if (code === 1013) {
          ws1013Errors.add(1);
          handoverEvents.add(1);
          console.log(`[VU ${vuId}] Room migration detected, will reconnect`);
        }
      });
      
      socket.on('error', function (e) {
        wsErrors.add(1);
        console.log(`[VU ${vuId}] WebSocket error: ${e.message || e}`);
      });
      
      if (CONFIG.simulateDrawing) {
        socket.setInterval(function () {
          if (socket.readyState === 1) {
            socket.send(generateTldrawMessage());
            wsMessagesSent.add(1);
          }
        }, CONFIG.activityIntervalMs);
      }
      
      socket.setTimeout(function () {
        socket.close();
      }, parseDuration(CONFIG.connectionDuration));
    });
    
    const connected = check(res, {
      'WebSocket connection established': (r) => r && r.status === 101,
    });
    
    if (!connected) {
      wsConnectionsFailed.add(1);
      
      if (reconnectAttempts < maxReconnects) {
        reconnectAttempts++;
        wsReconnects.add(1);
        console.log(`[VU ${vuId}] Connection failed, retrying (${reconnectAttempts}/${maxReconnects})...`);
        sleep(1 + Math.random() * 2);
        connect();
      } else {
        console.log(`[VU ${vuId}] Max reconnection attempts reached`);
      }
    }
  }
  
  connect();
}

export function setup() {
  console.log('='.repeat(60));
  console.log('TLDRAW SYNC STRESS TEST');
  console.log('='.repeat(60));
  console.log(`Target: ${CONFIG.baseUrl}`);
  console.log(`Rooms: ${CONFIG.totalRooms}`);
  console.log(`Users per room: ${CONFIG.usersPerRoom}`);
  console.log(`Total connections: ${TOTAL_VUS}`);
  console.log(`Ramp-up: ${CONFIG.rampUpDuration}`);
  console.log(`Duration: ${CONFIG.connectionDuration}`);
  console.log(`Activity interval: ${CONFIG.activityIntervalMs}ms`);
  console.log('='.repeat(60));
  
  return { startTime: Date.now() };
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log('='.repeat(60));
  console.log(`Test completed in ${duration.toFixed(1)}s`);
  console.log('='.repeat(60));
}
