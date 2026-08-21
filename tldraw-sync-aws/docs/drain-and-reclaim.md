# Drain and reclaim

**TL;DR** — Ownership of a Room lives in the bucket at `owners/{roomId}` and moves only when the previous owner is **gone**. There is no coordination, no pub/sub and no two-phase protocol, because a live worker is never asked to give a Room up. A worker leaving cleanly *drains*: deregister, wait for routers to notice, persist, vacate, close Sessions `1013`. A worker that dies is *reclaimed*: its membership record goes stale, the next connection reallocates the Room by conditional PUT, and the new owner loads the last Snapshot.

This replaces the two-phase coordinated Handover protocol, which was deleted along with Redis. See [ADR 0005](../../docs/adr/0005-room-ownership-in-the-bucket-routed-by-envoy.md) and the [design doc](../../docs/superpowers/specs/2026-08-19-bucket-registry-room-routing-design.md).

---

## Why there is no protocol any more

The Handover protocol existed because routing was a *hint*. `ingress-nginx` hashed `$uri` onto a ring that reshuffled on every scale event, so Sessions of one Room routinely reached a pod that did not own it. Something had to move ownership *between two live pods*, safely, while clients were connected — hence the pub/sub, the `handover-lock-released:*` and `handover-ready:*` channels, and the `1013` dance.

Routing now resolves an authoritative record, so that situation cannot arise. A live worker never receives a connection for a Room another live worker owns. Ownership only moves when the previous owner has left, and a departed worker needs no negotiation.

## Draining — a worker leaving cleanly

On `SIGTERM`, in this order. The order is load-bearing.

1. **Stop taking new Sessions and leave the live set.** `server.close()` refuses new connections without disturbing established ones, and `DELETE members/{addr}` removes the worker from Membership. `/api/health` starts failing.
2. **Wait `2 × MEMBER_POLL_INTERVAL` (~4s).** Every router polls `members/` on a 2s cycle; this is how long it takes for all of them to have seen the worker go.
3. **Per Room: persist the Snapshot, then vacate the record, then close Sessions `1013`.**
4. Exit.

**Skip step 2 and routers cheerfully reallocate Rooms straight back onto the worker that is shutting down.** That wait keys off the router's *poll* interval, not `MEMBER_TTL` — the membership record is deleted rather than left to expire, so a clean drain never waits out the TTL and is unaffected by how it is tuned.

**Persist before vacating, never the other way round.** Vacating first would let another worker claim the Room and load a stale Snapshot while our write was still in flight, and then our write would land on top of theirs.

**Vacating is a conditional write to `owner: null`, never a delete.** An unconditional delete is a split-brain: a draining worker could erase a record that had already been reallocated to someone else. (Conditional `DELETE` is real on S3 since Nov 2024, but returns `501 Not Implemented` on the LocalStack version this repo pins, so CAS-to-vacant is the one form that behaves identically locally and in production.)

## Reclaiming — a worker that died

Nothing coordinates, because there is nobody to coordinate with.

1. The dead worker stops heartbeating. Its `members/{addr}` record ages past `MEMBER_TTL` (8s) and routers stop counting it live.
2. The next connection for one of its Rooms finds a recorded owner that is no longer in the live set, so the router reallocates the record by conditional PUT (`If-Match` on the current ETag). A `412` means another router won the race — re-read and use their answer.
3. The new owner loads the last Snapshot and serves the Room.

**Up to 10 seconds of edits can be lost**, because Snapshots are written on a 10s throttle and a crashed worker never got to persist. That is the same exposure the Redis design had; it is not a regression.

## What a client feels

| Event | Client |
|---|---|
| Scale **up** | Nothing. Existing Rooms keep their owner; only new Rooms land on new workers. |
| Scale **down**, worker held no Rooms | Nothing. |
| Scale **down**, worker held Rooms | Those Sessions close `1013` and reconnect into the new owner. Measured at ~530ms. |
| Worker **crashes** | Sessions drop. Reconnects succeed once the record is reallocated, bounded below by `MEMBER_TTL`. |
| Router restarts (mode A) | Nothing for established Sessions — Envoy holds them. New connects `503` on that replica until it is back. |

Under the old hash routing, scaling 2→3 moved roughly a third of Rooms and disconnected a client for every one. Measured on `local-cluster` across a 2→3→4→3→2 cycle: **26 Room moves and 26 disruptions before, 0 and 0 after.** See `tldraw-client/scale-drill.mjs`.

## The one hole worth naming

Ownership is still **check-then-write, not mutual exclusion.** The window between a worker reading "I own this Room" and its Snapshot PUT landing is milliseconds, but non-zero. Conditional writes did not close it. The Redis design had exactly the same window, so this is not a regression — but it should not be read as a claim that the bucket made ownership airtight.

Three re-reads keep that window small:

- **Every 5s while a Room has Sessions**, the owner re-reads its record. If it moved, the Room is dropped *without saving* and its Sessions are closed `1013`.
- **Every 2s**, the worker checks Membership for *itself*. If it cannot find itself live, it re-reads every Room it holds at once rather than waiting out the 5s cycle. This costs one LIST per worker, not one GET per Room.
- **Immediately before every Snapshot write**, the owner re-reads. A Room whose ownership moved must not clobber the new owner's Snapshot.
