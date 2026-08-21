import { createClient } from "redis"
import { MEMBER_TTL_MS, type Member, type OwnerRecord } from "./registryConfig.js"

// Redis as the coordination store, behind exactly the same surface as the S3
// backend. Everything above this file — resolve(), both router transports, the
// worker — is unchanged, because the interesting property was never "the
// record is in a bucket", it was "routing resolves an authoritative record".
//
// Two things Redis does better than conditional PUT, and they are why this
// backend exists at all:
//
//   - Lua runs atomically, so compare-and-set has no window at all. S3's
//     conditional PUT is the weaker primitive, not the stronger one.
//   - TTLs and timestamps are millisecond-precise. S3 reports LastModified to
//     whole seconds, which silently costs the bucket backend up to 1s of its
//     8s liveness margin.
//
// And one thing it does worse, which Task 14's persistence health check exists
// to pay for: liveness and the ability to persist a Snapshot no longer share a
// channel, so a worker partitioned from S3 can hold ownership it cannot honour.

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379"

const client = createClient({ url: REDIS_URL })
client.on("error", (err) => console.error("[Registry/Redis] Client error:", err))

const connecting = client.connect().catch((err) => {
  console.error("[Registry/Redis] CRITICAL: failed to connect on startup:", err)
  process.exit(1)
})

const ready = async () => {
  await connecting
  return client
}

const OWNER_KEY = (roomId: string) => `owners:${roomId}`
const MEMBERS_ZSET = "members"
const MEMBERS_ROOMS = "members:rooms"

// `version` is the ETag. Absent key means "no record"; an empty owner field
// means a vacated record, which is a different thing — it still has a version,
// so reclaiming it is a compare-and-set rather than a create.
const CAS_OWNER = `
  local current = redis.call('HGET', KEYS[1], 'version')
  if ARGV[1] == '' then
    if current then return 0 end
    redis.call('HSET', KEYS[1], 'owner', ARGV[2], 'version', '1')
    return 1
  end
  if not current or current ~= ARGV[1] then return 0 end
  redis.call('HSET', KEYS[1], 'owner', ARGV[2], 'version', tostring(tonumber(current) + 1))
  return 1`

// Scored by Redis's own clock, read in the same round trip, so worker clocks
// never have to agree with one another.
const PUT_MEMBER = `
  local t = redis.call('TIME')
  local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  redis.call('ZADD', KEYS[1], now, ARGV[1])
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
  return now`

// Returns Redis's current time first, then addr/score/rooms triples — the
// room count is the allocation weight, read in the same round trip. Expired
// entries are reaped in the same call, so nothing accumulates.
const LIST_MEMBERS = `
  local t = redis.call('TIME')
  local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  local cutoff = now - tonumber(ARGV[1])
  local dead = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', '(' .. cutoff)
  for _, addr in ipairs(dead) do redis.call('HDEL', KEYS[2], addr) end
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. cutoff)
  local live = redis.call('ZRANGEBYSCORE', KEYS[1], cutoff, '+inf', 'WITHSCORES')
  local out = { tostring(now) }
  for i = 1, #live, 2 do
    table.insert(out, live[i])
    table.insert(out, live[i + 1])
    table.insert(out, redis.call('HGET', KEYS[2], live[i]) or '0')
  end
  return out`

export async function readOwner(roomId: string): Promise<OwnerRecord | null> {
  const redis = await ready()
  const [owner, version] = await redis.hmGet(OWNER_KEY(roomId), ["owner", "version"])
  if (version === null || version === undefined) return null
  // An empty owner is a vacated record, not an absent one.
  return { owner: owner ? owner : null, etag: String(version) }
}

export async function casOwner(
  roomId: string,
  expect: string | null,
  owner: string | null,
): Promise<"ok" | "conflict"> {
  const redis = await ready()
  const result = await redis.eval(CAS_OWNER, {
    keys: [OWNER_KEY(roomId)],
    arguments: [expect ?? "", owner ?? ""],
  })
  return result === 1 ? "ok" : "conflict"
}

export async function putMember(addr: string, rooms: number): Promise<void> {
  const redis = await ready()
  await redis.eval(PUT_MEMBER, {
    keys: [MEMBERS_ZSET, MEMBERS_ROOMS],
    arguments: [addr, String(rooms)],
  })
}

export async function listMembers(): Promise<Member[]> {
  const redis = await ready()
  const raw = (await redis.eval(LIST_MEMBERS, {
    keys: [MEMBERS_ZSET, MEMBERS_ROOMS],
    arguments: [String(MEMBER_TTL_MS)],
  })) as string[]

  if (!Array.isArray(raw) || raw.length === 0) return []

  // Ages are computed on Redis's clock, then expressed in ours, so callers can
  // keep passing their own Date.now() to liveMembers() for either backend.
  const serverNow = Number(raw[0])
  const localNow = Date.now()

  const members: Member[] = []
  for (let i = 1; i + 2 < raw.length; i += 3) {
    members.push({
      addr: raw[i],
      updatedAt: localNow - (serverNow - Number(raw[i + 1])),
      rooms: Number(raw[i + 2]) || 0,
    })
  }
  return members
}

export async function deleteMember(addr: string): Promise<void> {
  const redis = await ready()
  await Promise.all([redis.zRem(MEMBERS_ZSET, addr), redis.hDel(MEMBERS_ROOMS, addr)])
}
