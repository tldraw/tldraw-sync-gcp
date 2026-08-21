// In-memory stand-in for node-redis, covering only what registryRedis.ts uses.
//
// The three Lua scripts are re-implemented rather than interpreted, and they
// are matched on a distinguishing substring so an unrecognised script throws
// instead of silently no-opping. That matters: a CAS that quietly always
// succeeds would make every ownership test pass while the real thing was
// broken.

type Hash = Map<string, string>

const hashes = new Map<string, Hash>()
const zsets = new Map<string, Map<string, number>>()

// Advanced by tests to age members out; stands in for Redis's own TIME.
let serverNowMs = 1_800_000_000_000

const hash = (key: string): Hash => {
  let h = hashes.get(key)
  if (!h) {
    h = new Map()
    hashes.set(key, h)
  }
  return h
}

const zset = (key: string): Map<string, number> => {
  let z = zsets.get(key)
  if (!z) {
    z = new Map()
    zsets.set(key, z)
  }
  return z
}

function casOwner(key: string, expect: string, owner: string): number {
  const h = hashes.get(key)
  const current = h?.get("version")

  if (expect === "") {
    if (current !== undefined) return 0
    hash(key).set("owner", owner)
    hash(key).set("version", "1")
    return 1
  }

  if (current === undefined || current !== expect) return 0
  hash(key).set("owner", owner)
  hash(key).set("version", String(Number(current) + 1))
  return 1
}

function putMember(zsetKey: string, roomsKey: string, addr: string, rooms: string): number {
  zset(zsetKey).set(addr, serverNowMs)
  hash(roomsKey).set(addr, rooms)
  return serverNowMs
}

function listMembers(zsetKey: string, roomsKey: string, ttlMs: number): string[] {
  const cutoff = serverNowMs - ttlMs
  const z = zset(zsetKey)

  for (const [addr, score] of [...z]) {
    if (score < cutoff) {
      z.delete(addr)
      hashes.get(roomsKey)?.delete(addr)
    }
  }

  const out: string[] = [String(serverNowMs)]
  for (const [addr, score] of [...z].sort((a, b) => a[1] - b[1])) {
    out.push(addr, String(score))
  }
  return out
}

export function createClient() {
  const client = {
    on: () => client,
    connect: async () => {},
    quit: async () => {},

    hmGet: async (key: string, fields: string[]) =>
      fields.map((f) => hashes.get(key)?.get(f) ?? null),

    hDel: async (key: string, field: string) => (hashes.get(key)?.delete(field) ? 1 : 0),

    zRem: async (key: string, member: string) => (zsets.get(key)?.delete(member) ? 1 : 0),

    eval: async (
      script: string,
      { keys, arguments: args }: { keys: string[]; arguments: string[] },
    ) => {
      if (script.includes("HGET")) return casOwner(keys[0], args[0], args[1])
      if (script.includes("ZADD")) return putMember(keys[0], keys[1], args[0], args[1])
      if (script.includes("ZRANGEBYSCORE")) return listMembers(keys[0], keys[1], Number(args[0]))
      throw new Error(`fakeRedis: unrecognised script:\n${script}`)
    },
  }
  return client
}

/** Test-side controls: inspect state, or move Redis's clock forward. */
export const bus = {
  reset: () => {
    hashes.clear()
    zsets.clear()
    serverNowMs = 1_800_000_000_000
  },
  advance: (ms: number) => {
    serverNowMs += ms
  },
  now: () => serverNowMs,
  ownerOf: (roomId: string) => hashes.get(`owners:${roomId}`)?.get("owner") ?? null,
  versionOf: (roomId: string) => hashes.get(`owners:${roomId}`)?.get("version") ?? null,
  roomsFor: (addr: string) => hashes.get("members:rooms")?.get(addr) ?? null,
}
