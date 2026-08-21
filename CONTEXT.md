# tldraw sync cloud demos

The shared vocabulary of the two per-cloud sync backend demos. Both demos implement the same domain, so the language here is deliberately cloud-neutral.

> **The two demos no longer answer ownership the same way.** `tldraw-sync-gcp` keeps a leased **Room Lock** in Redis with hash-based routing; `tldraw-sync-aws` keeps ownership in the bucket and resolves it authoritatively at the proxy ([ADR 0005](docs/adr/0005-room-ownership-in-the-bucket-routed-by-envoy.md)). Where the two differ, the entries below say which demo they describe. Everything not marked applies to both.

## Language

### Collaboration

**Room**:
A single collaborative tldraw document, identified by a `roomId`.
_Avoid_: board, canvas, document, whiteboard

**Session**:
One client's connection to a Room, identified by a `sessionId`.
_Avoid_: user, connection, client, socket

**Snapshot**:
The serialized state of a Room in object storage — the only durable representation of a Room.
_Avoid_: save, backup, state, persisted document

**Asset**:
A binary file (image or video) referenced by a Room but stored outside the Room's records.
_Avoid_: upload, attachment, file, media

### Ownership

**Room Owner**:
The single server instance permitted to hold a Room in memory and serve its Sessions.
_Avoid_: leader, primary, host, master, active pod

**Room Lock**:
The claim that makes a server instance the Room Owner.
- _GCP_: held for a fixed lease and renewed while owned. Letting the lease lapse gives the Room up.
- _AWS_: **no lease and no renewal.** Ownership is one durable record per Room, written by conditional PUT, and it stays until someone conditionally rewrites it. Liveness is answered separately, by worker membership, so ownership does not need a clock.
_Avoid_: mutex, semaphore, reservation

**Owner Identity**:
The value that distinguishes one server instance from another for the purpose of holding a Room Lock.
- _GCP_: a pod name plus a random suffix, meaningful only as a comparison.
- _AWS_: a **dialable address** — scheme, host and port — so the same string that proves ownership is also the one a router connects to. One notion of identity that cannot drift.
_Avoid_: node id, pod name, hostname, server id

**Handover** _(GCP only)_:
The coordinated transfer of a Room from one Room Owner to another, during which the Snapshot is persisted by the outgoing owner and loaded by the incoming one before any Session is disturbed.
_Avoid_: migration, failover, rebalance, transfer

**Reclaim** _(AWS)_:
Taking ownership of a Room whose previous owner is **gone** — drained or dead. It replaces Handover rather than renaming it: there is no coordination and no cross-worker signalling, because a live worker never has a Room taken from it. The new owner loads the last Snapshot.
_Avoid_: handover, failover, steal

**Membership** _(AWS)_:
The set of workers currently alive, each refreshing its own record on a heartbeat. It answers liveness so that ownership does not have to, and it replaces service discovery entirely.
_Avoid_: registry, cluster state, roster

**Room Affinity**:
The routing property that sends all Sessions of one Room to the same server instance.
- _GCP_: a **hint**. Consistent hashing on the request path is right most of the time, and the ring reshuffles on every scale event, so Sessions routinely reach a worker that does not own the Room. Handover is what makes that survivable.
- _AWS_: a **guarantee**, resolved per connection from the ownership record. A live worker never receives a connection for a Room another live worker owns.

Affinity must be a function of the `roomId`. Affinity that is a function of the client — cookie stickiness, client-IP hashing — is not Room Affinity at all: it scatters the Sessions of one Room across instances and makes Handover self-sustaining.
_Avoid_: stickiness, session affinity, pinning

### Deployment

**Deployment Target**:
One way of running the server on a cloud — the compute service plus the routing and infrastructure around it. A cloud may have several; the server is the same in each.
_Avoid_: example, demo, environment, platform

## Relationships

- A **Room** has zero or more **Sessions**
- A **Room** has exactly one **Room Owner** at any moment, and at most one **Room Lock**
- A **Room Lock** is held by exactly one **Owner Identity**
- A **Room** has exactly one current **Snapshot**; a **Snapshot** belongs to exactly one **Room**
- A **Room** references zero or more **Assets**; an **Asset** outlives the **Room** that references it
- A **Handover** transfers one **Room** between two **Owner Identities**, and always writes a **Snapshot**
- Weak **Room Affinity** increases the rate of **Handovers**; it is not what establishes ownership _(GCP)_
- A **Reclaim** transfers one **Room** to a new **Owner Identity**, and only ever from one that has left **Membership** _(AWS)_
- A **Deployment Target** runs many server instances, each with its own **Owner Identity**. Whether it can provide **Room Affinity** is a property of the target _(GCP)_ or of the application _(AWS, where any target that can route to an instance address can provide it)_

## Example dialogue

> **Dev:** If routing already sends everyone in a **Room** to the same instance, why do we need the **Room Lock** at all?
>
> **Domain expert:** In GCP, because **Room Affinity** is a hint, not a guarantee — the hash ring reshuffles whenever we scale. The **Room Lock** is what actually decides the **Room Owner**. Affinity only decides how often we pay for a **Handover**.
>
> **Dev:** And in AWS?
>
> **Domain expert:** There the question goes away. Routing resolves the ownership record itself, so affinity *is* the guarantee — a live worker is never sent a **Room** someone else owns. Which is why AWS has no **Handover**: ownership only moves when the previous owner is already gone, and that needs no coordination at all.
>
> **Dev:** And when a **Handover** happens, do the **Sessions** just get dropped?
>
> **Domain expert:** They get closed, but only after the incoming owner has loaded the **Snapshot** and said it's ready. The clients reconnect into the new owner. If we closed them first, they'd reconnect into a **Room** that nobody owns yet. In AWS a **Reclaim** does close them first — but only because the previous owner is gone, so there is nothing to coordinate with.
>
> **Dev:** One of our **Deployment Targets** can only be sticky per browser, not per **Room**. That's still some affinity, right?
>
> **Domain expert:** No — that's the wrong axis, and it's worse than none. Two people in one **Room** get pinned to two different instances, so each reconnect drags the **Room** back across and evicts the other one. The **Room Lock** still keeps it correct; you just never stop paying for **Handovers**.

## Flagged ambiguities

- "user" was used for both a human collaborator and a **Session** — resolved: one person opening two tabs is two **Sessions**.
- "room" was used for both the durable document and the live in-memory instance — resolved: **Room** is the document; the live instance is held by its **Room Owner**, and its durable form is the **Snapshot**.
- "handover" and "migration" were used interchangeably; "migration" also suggests moving between clouds — resolved: **Handover** only ever means transfer between two server instances of the same demo.
- "Pod Identity" was the term until GCP grew Cloud Run and Compute Engine **Deployment Targets**, where nothing is a pod and its _Avoid_ list ruled out the words those platforms actually use — renamed to **Owner Identity**, which names what the value is for rather than what happens to host it. The GCP code still says `POD_NAME`; that rename is outstanding there. AWS now uses `ADVERTISE_ADDR`, which is the identity and the dialable address at once.
- "Handover" covered both "a live owner gives a Room up" and "a Room is taken from an owner that has gone" — resolved: they are different events with different costs, so AWS calls the second a **Reclaim** and no longer has the first. GCP keeps **Handover** for both, because under hash routing it cannot tell them apart.
- "example" was used both for a **Deployment Target** and for the sample frontends under `examples/` — resolved: the three directories under `tldraw-sync-gcp/` are **Deployment Targets**.
