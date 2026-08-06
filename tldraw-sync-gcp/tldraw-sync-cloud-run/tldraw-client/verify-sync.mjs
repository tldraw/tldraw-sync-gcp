/**
 * End-to-end verification of the GCP multiplayer sync backend.
 *
 * Uses the real @tldraw/sync-core TLSyncClient (the same engine `useSync`
 * uses in the browser) to verify, against a locally running server:
 *
 *   1. Two clients can join the same room (Redis lock + room creation)
 *   2. A shape created by client A appears in client B's store (live sync)
 *   3. An edit by client B propagates back to client A (bidirectional sync)
 *   4. After all clients leave, the snapshot is persisted to GCS
 *   5. A new client joining later loads the persisted snapshot (restore)
 *
 * Prereqs: Redis on :6379, fake-gcs-server on :4443, and the server
 * running with GCS_API_ENDPOINT + GCS_BUCKET_NAME set:
 *
 *   docker run -d -p 6379:6379 redis:7-alpine
 *   docker run -d -p 4443:4443 fsouza/fake-gcs-server \
 *     -scheme http -port 4443 -public-host localhost:4443 -external-url http://localhost:4443
 *   curl -X POST "http://localhost:4443/storage/v1/b?project=test" \
 *     -H "Content-Type: application/json" -d '{"name":"tldraw-test-bucket"}'
 *   REDIS_URL=redis://localhost:6379 GCS_BUCKET_NAME=tldraw-test-bucket \
 *     GCS_API_ENDPOINT=http://localhost:4443 PORT=3001 node dist/index.js
 *
 * Usage: node verify-sync.mjs [server-url]
 */
import { TLSyncClient, ClientWebSocketAdapter } from "@tldraw/sync-core"
import {
  createTLStore,
  defaultShapeUtils,
  defaultBindingUtils,
  atom,
  createShapeId,
  toRichText,
} from "tldraw"

// ClientWebSocketAdapter's ReconnectManager listens to browser online/offline
// and visibility events; give it inert stand-ins so it runs under Node.
const noopEvents = {
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window ??= {
  ...noopEvents,
  navigator: { onLine: true },
  devicePixelRatio: 1,
  innerWidth: 1280,
  innerHeight: 720,
  matchMedia: () => ({ matches: false, ...noopEvents }),
}
globalThis.document ??= { ...noopEvents, hidden: false, visibilityState: "visible" }
globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16)
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id)

const SERVER_URL = process.argv[2] || "http://localhost:3001"
const WS_URL = SERVER_URL.replace(/^http/, "ws")
const ROOM_ID = `verify-room-${Math.random().toString(36).slice(2, 8)}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connectClient(sessionId) {
  const store = createTLStore({
    shapeUtils: defaultShapeUtils,
    bindingUtils: defaultBindingUtils,
  })
  const socket = new ClientWebSocketAdapter(
    () => `${WS_URL}/api/connect/${ROOM_ID}?sessionId=${sessionId}`,
  )
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${sessionId}: connect timed out`)), 10_000)
    const client = new TLSyncClient({
      store,
      socket,
      presence: atom("presence", null),
      onLoad: () => {
        clearTimeout(timeout)
        resolve({ client, store, socket, sessionId })
      },
      onSyncError: (reason) => {
        clearTimeout(timeout)
        reject(new Error(`${sessionId}: sync error: ${reason}`))
      },
    })
  })
}

async function waitFor(label, predicate, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      console.log(`  ✅ ${label}`)
      return
    }
    await sleep(100)
  }
  throw new Error(`❌ ${label} (timed out after ${timeoutMs}ms)`)
}

console.log(`Room: ${ROOM_ID} on ${SERVER_URL}\n`)

// 1. Two clients join the same room
console.log("1. Connecting client A and client B...")
const a = await connectClient("client-a")
console.log("  ✅ client A connected + initial sync loaded")
const b = await connectClient("client-b")
console.log("  ✅ client B connected + initial sync loaded")

// 2. Client A creates a shape → client B sees it
console.log("2. Client A creates a shape...")
const pageId = a.store.query.records("page").get()[0].id
const shapeId = createShapeId()
a.store.put([
  {
    id: shapeId,
    typeName: "shape",
    type: "geo",
    parentId: pageId,
    index: "a1",
    x: 100,
    y: 100,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      geo: "rectangle",
      dash: "draw",
      url: "",
      w: 200,
      h: 100,
      growY: 0,
      scale: 1,
      labelColor: "black",
      color: "black",
      fill: "none",
      size: "m",
      font: "draw",
      align: "middle",
      verticalAlign: "middle",
      richText: toRichText("synced via GCP backend"),
    },
  },
])
await waitFor("shape from A visible in B's store", () => b.store.has(shapeId))

// 3. Client B edits the shape → client A sees the edit
console.log("3. Client B moves the shape...")
b.store.put([{ ...b.store.get(shapeId), x: 555 }])
await waitFor("B's edit visible in A's store", () => a.store.get(shapeId)?.x === 555)

// 4. Both clients leave → server persists snapshot to GCS (throttled, ≤10s)
console.log("4. Disconnecting both clients, waiting for GCS persistence...")
a.client.close()
a.socket.close()
b.client.close()
b.socket.close()
await sleep(12_000)

const gcsRes = await fetch(
  `http://localhost:4443/storage/v1/b/tldraw-test-bucket/o/${encodeURIComponent(`rooms/${ROOM_ID}`)}?alt=media`,
)
if (!gcsRes.ok) throw new Error(`❌ snapshot not found in GCS (HTTP ${gcsRes.status})`)
const snapshot = await gcsRes.json()
const persisted = snapshot.documents?.find((d) => d.state.id === shapeId)
if (!persisted || persisted.state.x !== 555) {
  throw new Error("❌ persisted snapshot missing the shape (or missing B's edit)")
}
console.log("  ✅ snapshot in GCS contains the shape with B's edit (x=555)")

// 5. A fresh client joins after the room was evicted → loads from GCS
console.log("5. Fresh client C joins the (now cold) room...")
const c = await connectClient("client-c")
try {
  await waitFor("client C sees the persisted shape", () => c.store.get(shapeId)?.x === 555)
} catch (err) {
  console.log(
    "  ℹ️ client C store contents:",
    c.store
      .allRecords()
      .map((r) => `${r.typeName}:${r.id}${r.typeName === "shape" ? ` x=${r.x}` : ""}`),
  )
  throw err
}
c.client.close()
c.socket.close()

console.log("\n🎉 All checks passed — multiplayer sync + GCS persistence work on tldraw v5.")
process.exit(0)
