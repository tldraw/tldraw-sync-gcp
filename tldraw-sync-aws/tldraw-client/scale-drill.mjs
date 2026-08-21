/**
 * Scale drill: measures what a client feels when the demo scales.
 *
 * Makes the dashboard's question numeric, so two implementations can be
 * compared on the same evidence:
 *
 *   1. How many Rooms change owner across a scale event? Hash routing
 *      reshuffles the ring; record routing should disturb nothing on scale up.
 *   2. How many held Sessions are disconnected, and for how long?
 *   3. Does any connect fail, and what does connect latency look like?
 *
 * Sessions are real `TLSyncClient`s — the same engine `useSync` runs in the
 * browser. A raw WebSocket is not good enough: `TLSocketRoom` prunes a session
 * that has not sent a connect message within 10s, so a bare socket silently
 * dies before the scale event finishes and every number after it is fiction.
 *
 * Ownership is read from whichever store the deployment uses, so the same
 * drill works before and after Redis is removed:
 *   --owner-probe redis-lock       lock:room:{id}        (the old Redis design)
 *   --owner-probe bucket           owners/{id} in S3     (registry, s3 backend)
 *   --owner-probe redis-registry   owners:{id} hash      (registry, redis backend)
 * Default is auto, which prefers Redis's registry keys, then the bucket
 * prefix, then the legacy lock. Pass it explicitly when both stores hold
 * leftovers from an earlier run.
 *
 * Usage:
 *   node scale-drill.mjs --to 3
 *   node scale-drill.mjs --steps 3,4,3,2          # up twice, down twice
 *   node scale-drill.mjs --url http://localhost:8081 --rooms 24 --json out.json
 */

import { execFile } from "child_process"
import { promisify } from "util"
import { writeFileSync } from "fs"
import { TLSyncClient, ClientWebSocketAdapter } from "@tldraw/sync-core"
import { createTLStore, defaultShapeUtils, defaultBindingUtils, atom } from "tldraw"

const exec = promisify(execFile)

// ClientWebSocketAdapter's ReconnectManager listens to browser online/offline
// and visibility events; give it inert stand-ins so it runs under Node.
const noopEvents = { addEventListener() {}, removeEventListener() {} }
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

// --- arguments -------------------------------------------------------------

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const URL_BASE = arg("url", "http://aws.localhost:8080")
const WS_BASE = URL_BASE.replace(/^http/, "ws")
const ROOMS = Number(arg("rooms", 12))

// A sequence of replica counts to walk through, e.g. "3,4,3,2" for two scale
// ups followed by two scale downs. `--to N` is shorthand for a single step.
// Up and down are not symmetric: scaling up only reshuffles routing, while
// scaling down terminates a worker and drains whatever it owned, so each step
// is measured on its own.
const STEPS = arg("steps", null)
  ? String(arg("steps"))
      .split(",")
      .map((value) => Number(value.trim()))
  : [Number(arg("to", 3))]

const NAMESPACE = arg("namespace", "tldraw-aws")
const DEPLOYMENT = arg("deployment", "tldraw-aws-app")
const CONTEXT = arg("context", "k3d-tldraw-local")
const BUCKET = arg("bucket", "tldraw-test-bucket")
const JSON_OUT = arg("json", null)
const OBSERVE_MS = Number(arg("observe", 15_000))
const LABEL = arg("label", "run")
let OWNER_PROBE = arg("owner-probe", "auto")

const RUN = Math.random().toString(36).slice(2, 8)
const roomIds = Array.from({ length: ROOMS }, (_, i) => `drill-${RUN}-${i}`)

const kubectl = (...args) => exec("kubectl", ["--context", CONTEXT, "-n", NAMESPACE, ...args])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// --- ownership probes ------------------------------------------------------

// Emitted as `id=value` lines rather than via `mget`, whose blank lines for
// absent keys collapse and silently shift every later room onto a wrong owner.
function parseOwnerLines(stdout, ids) {
  const owners = Object.fromEntries(ids.map((id) => [id, null]))
  for (const line of stdout.split("\n")) {
    const split = line.indexOf("=")
    if (split === -1) continue
    const id = line.slice(0, split)
    const value = line.slice(split + 1).trim()
    if (id in owners && value) owners[id] = value
  }
  return owners
}

async function ownersViaRedisLock(ids) {
  const script = ids.map((id) => `echo -n "${id}="; redis-cli get "lock:room:${id}"`).join("; ")
  const { stdout } = await kubectl("exec", "deploy/tldraw-aws-redis", "--", "sh", "-c", script)
  return parseOwnerLines(stdout, ids)
}

// The registry's Redis backend keeps ownership in a hash per Room, with the
// version acting as the ETag. An empty owner field is a vacated record.
async function ownersViaRedisRegistry(ids) {
  const script = ids
    .map((id) => `echo -n "${id}="; redis-cli hget "owners:${id}" owner`)
    .join("; ")
  const { stdout } = await kubectl("exec", "deploy/tldraw-aws-redis", "--", "sh", "-c", script)
  return parseOwnerLines(stdout, ids)
}

async function ownersViaBucket(ids) {
  const script = ids
    .map((id) => `echo -n "${id}="; awslocal s3 cp s3://${BUCKET}/owners/${id} - 2>/dev/null; echo`)
    .join("; ")
  const { stdout } = await kubectl("exec", "deploy/tldraw-aws-localstack", "--", "sh", "-c", script)
  return Object.fromEntries(
    Object.entries(parseOwnerLines(stdout, ids)).map(([id, body]) => {
      if (!body) return [id, null]
      try {
        return [id, JSON.parse(body).owner ?? null]
      } catch {
        return [id, null]
      }
    }),
  )
}

async function detectProbe() {
  // Redis registry keys first: a cluster switched from the bucket backend still
  // has stale owners/ objects lying about, and picking those would silently
  // measure a store nothing is writing to any more.
  try {
    const { stdout } = await kubectl(
      "exec",
      "deploy/tldraw-aws-redis",
      "--",
      "sh",
      "-c",
      "redis-cli --scan --pattern 'owners:*' | head -1",
    )
    if (stdout.trim()) return "redis-registry"
  } catch {
    // No Redis deployed at all.
  }
  try {
    const { stdout } = await kubectl(
      "exec",
      "deploy/tldraw-aws-localstack",
      "--",
      "sh",
      "-c",
      `awslocal s3 ls s3://${BUCKET}/owners/ 2>/dev/null | head -1`,
    )
    if (stdout.trim()) return "bucket"
  } catch {
    // No LocalStack or no owners prefix; fall through to the legacy lock.
  }
  return "redis-lock"
}

const PROBES = {
  bucket: ownersViaBucket,
  "redis-registry": ownersViaRedisRegistry,
  "redis-lock": ownersViaRedisLock,
}

const readOwners = (ids) => PROBES[OWNER_PROBE](ids)

// --- sessions --------------------------------------------------------------

/**
 * A real held Session. Records every connection status transition, which is
 * the client-visible signal: a 1013 close shows up as offline, and the
 * adapter's own reconnect shows up as the online that follows it.
 */
function openSession(roomId, sessionId) {
  const startedAt = Date.now()
  const record = {
    roomId,
    sessionId,
    loadedAt: null,
    connectMs: null,
    failed: false,
    events: [],
    socket: null,
    client: null,
  }

  const store = createTLStore({ shapeUtils: defaultShapeUtils, bindingUtils: defaultBindingUtils })
  const socket = new ClientWebSocketAdapter(
    () => `${WS_BASE}/api/connect/${roomId}?sessionId=${sessionId}`,
  )
  record.socket = socket

  socket.onStatusChange((event) => {
    record.events.push({ at: Date.now(), status: event.status, reason: event.reason ?? null })
  })

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (!settled) {
        settled = true
        resolve(record)
      }
    }

    record.client = new TLSyncClient({
      store,
      socket,
      presence: atom("presence", null),
      onLoad: () => {
        record.loadedAt = Date.now()
        record.connectMs = record.loadedAt - startedAt
        finish()
      },
      onSyncError: (reason) => {
        record.failed = true
        record.syncError = String(reason)
        finish()
      },
    })

    setTimeout(() => {
      if (!settled) {
        record.failed = true
        record.timedOut = true
        finish()
      }
    }, 20_000)
  })
}

/**
 * Disruption a session saw inside one step's window: how many times it went
 * offline, and how long it took to come back.
 */
function disruption(record, since, until = Infinity) {
  const inWindow = record.events.filter((event) => event.at >= since && event.at <= until)
  const drops = inWindow.filter((event) => event.status !== "online")
  if (drops.length === 0) return { dropped: false, drops: 0, recoveryMs: null, recovered: true }

  const firstDrop = drops[0].at
  const recovery = record.events.find((event) => event.status === "online" && event.at > firstDrop)
  return {
    dropped: true,
    drops: drops.length,
    recoveryMs: recovery ? recovery.at - firstDrop : null,
    recovered: Boolean(recovery),
  }
}

// --- cluster ---------------------------------------------------------------

async function specReplicas() {
  const { stdout } = await kubectl("get", "deploy", DEPLOYMENT, "-o", "jsonpath={.spec.replicas}")
  return Number(stdout.trim() || 0)
}

async function readyReplicas() {
  const { stdout } = await kubectl(
    "get",
    "deploy",
    DEPLOYMENT,
    "-o",
    "jsonpath={.status.readyReplicas}",
  )
  return Number(stdout.trim() || 0)
}

/**
 * Scaling down is only complete when the terminating pods are actually gone —
 * readyReplicas hits the target immediately while a draining pod is still
 * serving, and measuring there would miss the disruption entirely.
 */
async function podCount() {
  const { stdout } = await kubectl(
    "get",
    "pods",
    "-l",
    `app=${DEPLOYMENT}`,
    "-o",
    "jsonpath={.items[*].metadata.name}",
  )
  return stdout.trim() ? stdout.trim().split(/\s+/).length : 0
}

async function waitForScale(target, timeoutMs = 150_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await readyReplicas()) === target && (await podCount()) === target) return true
    await sleep(1000)
  }
  return false
}

const percentile = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

// --- the drill -------------------------------------------------------------

async function main() {
  if (OWNER_PROBE === "auto") OWNER_PROBE = await detectProbe()
  const startReplicas = await specReplicas()

  console.log("Scale drill")
  console.log(`  label        ${LABEL}`)
  console.log(`  url          ${URL_BASE}`)
  console.log(`  rooms        ${ROOMS}`)
  console.log(`  replicas     ${[startReplicas, ...STEPS].join(" -> ")}`)
  console.log(`  owner probe  ${OWNER_PROBE}\n`)

  // Hold one real Session per Room for the whole drill. These are the clients
  // whose experience is being measured; they persist across every step.
  console.log(`Opening ${ROOMS} held sessions...`)
  const held = await Promise.all(roomIds.map((id) => openSession(id, `held-${id}`)))
  const heldFailed = held.filter((s) => s.failed)
  console.log(`  loaded: ${held.length - heldFailed.length}/${ROOMS}, failed: ${heldFailed.length}`)
  if (heldFailed.length === ROOMS) throw new Error("no sessions loaded; is the demo reachable?")
  await sleep(3000)

  const triggers = []
  const stepResults = []
  let from = startReplicas

  for (const [index, target] of STEPS.entries()) {
    const direction = target > from ? "up" : target < from ? "down" : "flat"
    console.log(`\n=== Step ${index + 1}/${STEPS.length}: ${from} -> ${target} (${direction}) ===`)

    const ownersBefore = await readOwners(roomIds)
    const stepStart = Date.now()

    await kubectl("scale", "deploy", DEPLOYMENT, `--replicas=${target}`)
    const settled = await waitForScale(target)
    console.log(
      `  settled in ${((Date.now() - stepStart) / 1000).toFixed(1)}s${settled ? "" : " (TIMED OUT)"}`,
    )
    await sleep(4000)

    // A *new* connection is what re-resolves a Room. Under hash routing an
    // already-open socket is untouched until something reconnects, so without
    // this the ring reshuffle stays invisible.
    const stepTriggers = await Promise.all(
      roomIds.map((id) => openSession(id, `trigger-${index}-${id}`)),
    )
    triggers.push(...stepTriggers)
    const triggerFailed = stepTriggers.filter((s) => s.failed)

    await sleep(OBSERVE_MS)
    const stepEnd = Date.now()

    const ownersAfter = await readOwners(roomIds)
    const comparable = roomIds.filter((id) => ownersBefore[id] && ownersAfter[id])
    const moved = comparable.filter((id) => ownersBefore[id] !== ownersAfter[id])
    const lost = roomIds.filter((id) => ownersBefore[id] && !ownersAfter[id])

    const disruptions = held.map((session) => disruption(session, stepStart, stepEnd))
    const dropped = disruptions.filter((d) => d.dropped)
    const recoveries = dropped.map((d) => d.recoveryMs).filter((ms) => ms != null)
    const connectTimes = stepTriggers.filter((s) => s.connectMs != null).map((s) => s.connectMs)

    const step = {
      step: index + 1,
      from,
      to: target,
      direction,
      settled,
      ownership: {
        comparable: comparable.length,
        moved: moved.length,
        movedFraction: comparable.length ? moved.length / comparable.length : null,
        ownerlessAfter: lost.length,
      },
      heldSessions: {
        disrupted: dropped.length,
        neverRecovered: dropped.filter((d) => !d.recovered).length,
        recoveryMsP50: percentile(recoveries, 0.5),
        recoveryMsMax: recoveries.length ? Math.max(...recoveries) : null,
      },
      triggerSessions: { total: stepTriggers.length, failedToLoad: triggerFailed.length },
      connectMs: { p50: percentile(connectTimes, 0.5), p95: percentile(connectTimes, 0.95) },
    }
    stepResults.push(step)

    console.log(
      `  moved ${moved.length}/${comparable.length}` +
        (comparable.length ? ` (${Math.round((moved.length / comparable.length) * 100)}%)` : "") +
        ` | disrupted ${dropped.length}/${held.length}` +
        ` | recovery p50 ${step.heldSessions.recoveryMsP50 ?? "-"}ms` +
        ` | connect p50 ${step.connectMs.p50 ?? "-"}ms` +
        (triggerFailed.length ? ` | FAILED CONNECTS ${triggerFailed.length}` : "") +
        (lost.length ? ` | ownerless ${lost.length}` : ""),
    )

    from = target
  }

  const result = {
    label: LABEL,
    url: URL_BASE,
    ownerProbe: OWNER_PROBE,
    rooms: ROOMS,
    path: [startReplicas, ...STEPS],
    steps: stepResults,
    totals: {
      moved: stepResults.reduce((sum, s) => sum + s.ownership.moved, 0),
      disrupted: stepResults.reduce((sum, s) => sum + s.heldSessions.disrupted, 0),
      neverRecovered: stepResults.reduce((sum, s) => sum + s.heldSessions.neverRecovered, 0),
      failedConnects: heldFailed.length + triggers.filter((s) => s.failed).length,
      sessionsOpened: held.length + triggers.length,
    },
  }

  console.log("\n--- summary ---")
  console.log("step  from->to  dir    moved        disrupted  recovery  connect")
  for (const step of stepResults) {
    const movedText = `${step.ownership.moved}/${step.ownership.comparable}`
    console.log(
      `  ${String(step.step).padEnd(4)}${`${step.from}->${step.to}`.padEnd(10)}${step.direction.padEnd(7)}` +
        `${movedText.padEnd(13)}${String(step.heldSessions.disrupted).padEnd(11)}` +
        `${String(step.heldSessions.recoveryMsP50 ?? "-").padEnd(10)}${step.connectMs.p50 ?? "-"}ms`,
    )
  }
  console.log(
    `\nTotals: ${result.totals.moved} room moves, ${result.totals.disrupted} session disruptions, ` +
      `${result.totals.neverRecovered} never recovered, ${result.totals.failedConnects}/${result.totals.sessionsOpened} failed connects`,
  )

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(result, null, 2))
    console.log(`\nWrote ${JSON_OUT}`)
  }

  for (const session of [...held, ...triggers]) {
    try {
      session.client?.close()
      session.socket?.close()
    } catch {
      // Already closed.
    }
  }

  console.log(`\nLeaving ${DEPLOYMENT} at ${from} replicas. Reset with:`)
  console.log(
    `  kubectl --context ${CONTEXT} -n ${NAMESPACE} scale deploy ${DEPLOYMENT} --replicas=${startReplicas}`,
  )
  process.exit(0)
}

main().catch((error) => {
  console.error("Drill failed:", error)
  process.exit(1)
})
