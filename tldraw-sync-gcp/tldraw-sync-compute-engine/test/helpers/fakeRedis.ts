// In-memory stand-in for node-redis. Every client made via createClient() or
// duplicate() shares one key store and one pub/sub bus, modelling a single
// Redis server shared by all pods. Only the subset of the API the room manager
// uses is implemented (SET NX/XX/EX, GET, DEL, pub/sub).

type Entry = { value: string; expiresAt: number | null }
type Listener = (message: string, channel: string) => void
type EvalOptions = { keys: string[]; arguments: string[] }

const store = new Map<string, Entry>()
const subscribers = new Map<string, Set<Listener>>()

function liveEntry(key: string): Entry | undefined {
  const entry = store.get(key)
  if (!entry) return undefined
  if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
    store.delete(key)
    return undefined
  }
  return entry
}

function deliver(channel: string, message: string) {
  const listeners = subscribers.get(channel)
  if (!listeners) return 0
  for (const listener of [...listeners]) {
    queueMicrotask(() => listener(message, channel))
  }
  return listeners.size
}

export function createClient() {
  const client = {
    on: () => client,
    duplicate: () => createClient(),
    connect: async () => {},
    quit: async () => {},
    set: async (
      key: string,
      value: string,
      opts: { EX?: number; NX?: boolean; XX?: boolean } = {},
    ) => {
      const existing = liveEntry(key)
      if (opts.NX && existing) return null
      if (opts.XX && !existing) return null
      store.set(key, { value, expiresAt: opts.EX ? Date.now() + opts.EX * 1000 : null })
      return "OK"
    },
    get: async (key: string) => liveEntry(key)?.value ?? null,
    del: async (key: string) => {
      const existed = liveEntry(key) !== undefined
      store.delete(key)
      return existed ? 1 : 0
    },
    // Emulates the two ownership-checked Lua scripts rather than interpreting
    // Lua: both read the owner and act only if it is us. Anything else throws,
    // so a new script cannot silently no-op in tests.
    eval: async (script: string, { keys, arguments: args }: EvalOptions) => {
      const [key] = keys
      const [owner, ttlMs] = args
      const isOwner = liveEntry(key)?.value === owner

      if (script.includes("PEXPIRE")) {
        if (!isOwner) return 0
        store.set(key, { value: owner, expiresAt: Date.now() + Number(ttlMs) })
        return 1
      }
      if (script.includes("DEL")) {
        if (!isOwner) return 0
        store.delete(key)
        return 1
      }
      throw new Error(`fakeRedis: unrecognised script:\n${script}`)
    },
    subscribe: async (channel: string, listener: Listener) => {
      let set = subscribers.get(channel)
      if (!set) {
        set = new Set()
        subscribers.set(channel, set)
      }
      set.add(listener)
    },
    unsubscribe: async (channel: string) => {
      subscribers.delete(channel)
    },
    publish: async (channel: string, message: string) => deliver(channel, message),
  }
  return client
}

// Test-side controls: stand in for "another pod" on the same bus, or inspect state.
export const bus = {
  reset: () => {
    store.clear()
    subscribers.clear()
  },
  lockKey: (roomId: string) => `lock:room:${roomId}`,
  getLockOwner: (roomId: string) => liveEntry(`lock:room:${roomId}`)?.value ?? null,
  setLock: (roomId: string, owner: string, ttlSec = 10) => {
    store.set(`lock:room:${roomId}`, { value: owner, expiresAt: Date.now() + ttlSec * 1000 })
  },
  deleteLock: (roomId: string) => {
    store.delete(`lock:room:${roomId}`)
  },
  publish: (channel: string, message: string) => deliver(channel, message),
  subscribe: (channel: string, listener: Listener) => {
    let set = subscribers.get(channel)
    if (!set) {
      set = new Set()
      subscribers.set(channel, set)
    }
    set.add(listener)
  },
}
