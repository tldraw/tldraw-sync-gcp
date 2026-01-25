# Stress Test for tldraw-sync-gcp

WebSocket load testing using k6 to simulate high-concurrency scenarios with automatic report generation.

## Benchmark Results

Tested from within GCP (Cloud Shell) against production infrastructure:

| Configuration | VUs | Success Rate | Connection Latency |
|---------------|-----|--------------|-------------------|
| 5 NGINX + 10 pods | 5,000 | **100%** | 235ms (normal), ~8s (heavy) |
| 5 NGINX + 10 pods | 7,000 | **99.99%** | 235ms (normal), ~16s (heavy) |
| 5 NGINX + 10 pods | 10,000 | 30% | Exceeded capacity |

**Infrastructure**: 5 NGINX Ingress replicas, 10 app pods, 3× e2-medium nodes

**Key findings**:
- ~7,000 concurrent connections is the sweet spot for this configuration
- Connection latency is ~235ms under normal load
- Run tests from within GCP (Cloud Shell/VM) for accurate results
- Local machine network limits will skew results (we saw ~40% success locally vs 100% from GCP)

## Full Test with Scaling Events & Report

Run the complete stress test with automatic pod scaling and HTML/JSON report:

```bash
cd stress-test

# Full test: 100 rooms × 100 users = 10,000 connections
./run-full-stress-test.sh

# Custom configuration
ROOMS=50 USERS_PER_ROOM=50 DURATION=3m ./run-full-stress-test.sh
```

This will:
1. Start 10,000 concurrent WebSocket connections
2. Wait for ramp-up to complete
3. **Prompt you** to scale UP to 5 replicas (via GCP Console or kubectl)
4. Wait for your confirmation, then observe for 60s
5. **Prompt you** to scale DOWN to 2 replicas
6. Wait for your confirmation, then observe for 60s
7. Generate reports in `reports/` directory

The script is **interactive** - it will pause and show clear instructions for scaling, then wait for you to press ENTER after completing each scaling action.

### Generated Reports

| File | Description |
|------|-------------|
| `reports/stress-test-report-*.html` | Interactive HTML report with charts |
| `reports/stress-test-report-*.json` | Raw metrics data for processing |
| `reports/events-*.json` | Scaling events timeline |
| `reports/stress-test-*.log` | Full test log |

### Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `ROOMS` | `100` | Number of rooms |
| `USERS_PER_ROOM` | `100` | Users per room |
| `DURATION` | `5m` | Test duration |
| `RAMP_UP` | `2m` | Ramp-up time |
| `BASE_URL` | `wss://gcp-sync.tldraw.xyz` | Target server |
| `SCALE_UP_REPLICAS` | `5` | Replicas for scale-up |
| `SCALE_DOWN_REPLICAS` | `2` | Replicas for scale-down |
| `DEPLOYMENT_NAME` | `tldraw-sync` | K8s deployment name |

## Install k6

### Linux (Debian/Ubuntu)
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

### macOS
```bash
brew install k6
```

### Windows
```bash
choco install k6
```

### Docker (Recommended)
```bash
docker pull grafana/k6
```

## Using Docker (No k6 Installation Required)

```bash
cd stress-test

# Simple test
docker run --rm -i \
  -v $(pwd):/scripts \
  grafana/k6 run \
  -e BASE_URL=wss://gcp-sync.tldraw.xyz \
  -e ROOMS=10 \
  -e USERS_PER_ROOM=10 \
  -e DURATION=1m \
  /scripts/k6-stress-with-report.js

# Full test with report (creates reports/ directory)
docker run --rm -i \
  -v $(pwd):/scripts \
  grafana/k6 run \
  -e BASE_URL=wss://gcp-sync.tldraw.xyz \
  -e ROOMS=100 \
  -e USERS_PER_ROOM=100 \
  -e DURATION=5m \
  -e RAMP_UP=2m \
  /scripts/k6-stress-with-report.js
```

## Running from GCP Cloud Shell (Recommended)

For accurate results, run stress tests from within GCP's network. Cloud Shell has permission issues with volume mounts, so use stdin:

```bash
docker run --rm -i grafana/k6 run \
  -e BASE_URL=wss://gcp-sync.tldraw.xyz \
  -e ROOMS=100 \
  -e USERS_PER_ROOM=70 - << 'EOF'
import ws from 'k6/ws';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const ROOMS = parseInt(__ENV.ROOMS) || 100;
const USERS_PER_ROOM = parseInt(__ENV.USERS_PER_ROOM) || 70;
const BASE_URL = __ENV.BASE_URL || 'wss://gcp-sync.tldraw.xyz';

const wsConnectTime = new Trend('ws_connect_time', true);
const wsFailed = new Counter('ws_failed');
const wsSuccess = new Counter('ws_success');

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
};

export default function () {
  const roomId = `room-${Math.floor(__VU / USERS_PER_ROOM) % ROOMS}`;
  const url = `${BASE_URL}/api/connect/${roomId}?sessionId=stress-${__VU}-${__ITER}`;
  
  const start = Date.now();
  const res = ws.connect(url, { tags: { name: 'ws' } }, (socket) => {
    wsConnectTime.add(Date.now() - start);
    wsSuccess.add(1);
    
    socket.on('message', () => {});
    socket.setTimeout(() => socket.close(), 30000);
  });
  
  if (!check(res, { 'connected': (r) => r && r.status === 101 })) {
    wsFailed.add(1);
  }
}
EOF
```

This tests 7,000 VUs (100 rooms × 70 users) from inside GCP's network.

## Quick Start

### Small Test (10 rooms × 10 users = 100 connections)
```bash
k6 run -e ROOMS=10 -e USERS_PER_ROOM=10 -e DURATION=1m -e RAMP_UP=30s k6-websocket-stress.js
```

### Medium Test (50 rooms × 50 users = 2,500 connections)
```bash
k6 run -e ROOMS=50 -e USERS_PER_ROOM=50 -e DURATION=3m -e RAMP_UP=1m k6-websocket-stress.js
```

### Full Test (100 rooms × 100 users = 10,000 connections)
```bash
k6 run -e ROOMS=100 -e USERS_PER_ROOM=100 -e DURATION=5m -e RAMP_UP=2m k6-websocket-stress.js
```

## Configuration Options

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `BASE_URL` | `ws://localhost:3001` | WebSocket server URL |
| `ROOMS` | `100` | Number of rooms to create |
| `USERS_PER_ROOM` | `100` | Users per room |
| `DURATION` | `5m` | How long to maintain connections |
| `RAMP_UP` | `2m` | Time to ramp up to full load |
| `ACTIVITY_INTERVAL` | `5000` | Milliseconds between simulated draws |
| `SIMULATE_DRAWING` | `true` | Send mock tldraw messages |

## Testing Against Production

```bash
k6 run \
  -e BASE_URL=wss://gcp-sync.tldraw.xyz \
  -e ROOMS=100 \
  -e USERS_PER_ROOM=100 \
  -e DURATION=5m \
  k6-websocket-stress.js
```

## Testing Scale Events

To test the two-phase handover during scaling:

1. Start the stress test
2. While running, scale the deployment:
   ```bash
   kubectl scale deployment tldraw-sync --replicas=5
   ```
3. Observe the `ws_1013_room_migration` and `handover_events` metrics
4. Scale down:
   ```bash
   kubectl scale deployment tldraw-sync --replicas=2
   ```

## Metrics

| Metric | Description |
|--------|-------------|
| `ws_connect_time` | Time to establish WebSocket connection |
| `ws_message_latency` | Time between received messages |
| `ws_connections_active` | Current active connections |
| `ws_connections_failed` | Failed connection attempts |
| `ws_connections_success` | Successful connections |
| `ws_messages_received` | Total messages received |
| `ws_messages_sent` | Total messages sent |
| `ws_reconnects` | Reconnection attempts |
| `ws_1013_room_migration` | Room migration events (code 1013) |
| `ws_errors` | WebSocket errors |
| `handover_events` | Two-phase handover events detected |

## Thresholds

The test will fail if:
- 95th percentile connection time > 5 seconds
- More than 100 failed connections
- More than 1000 room migration events

## Output Example

```
          /\      |‾‾| /‾‾/   /‾‾/   
     /\  /  \     |  |/  /   /  /    
    /  \/    \    |     (   /   ‾‾\  
   /          \   |  |\  \ |  (‾)  | 
  / __________ \  |__| \__\ \_____/ .io

============================================================
TLDRAW SYNC STRESS TEST
============================================================
Target: ws://localhost:3001
Rooms: 100
Users per room: 100
Total connections: 10000
Ramp-up: 2m
Duration: 5m
Activity interval: 5000ms
============================================================

     data_received..............: 1.2 GB  2.4 MB/s
     data_sent..................: 890 MB  1.8 MB/s
     ws_connect_time............: avg=234ms min=12ms med=189ms max=4.2s p(90)=456ms p(95)=890ms
     ws_connections_active......: 10000   
     ws_connections_failed......: 23      
     ws_connections_success.....: 10023   
     ws_1013_room_migration.....: 156     
     handover_events............: 156     
```

## Distributed Testing

For tests larger than 10,000 connections, use k6 Cloud or distribute across machines:

```bash
k6 cloud k6-websocket-stress.js
```

Or run multiple k6 instances with different room ranges.

## Troubleshooting

### "Too many open files"
Increase ulimit before running:
```bash
ulimit -n 65535
```

### Connection timeouts
- Check server health: `curl http://localhost:3001/api/health`
- Verify Redis is running
- Check pod logs: `kubectl logs -l app=tldraw-sync`

### High 1013 errors
This indicates frequent room migrations. Check:
- HPA scaling thresholds
- Pod startup time
- Handover timeout settings
