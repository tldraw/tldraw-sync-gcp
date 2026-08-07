# tldraw sync cloud demos

The shared vocabulary of the two per-cloud sync backend demos. Both demos implement the same domain; only their cloud services differ, so the language here is deliberately cloud-neutral.

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
The claim that makes a server instance the Room Owner, held for a fixed lease and renewed while owned.
_Avoid_: mutex, semaphore, ownership record, reservation

**Owner Identity**:
The value that distinguishes one server instance from another for the purpose of holding a Room Lock.
_Avoid_: node id, pod name, hostname, server id

**Handover**:
The coordinated transfer of a Room from one Room Owner to another, during which the Snapshot is persisted by the outgoing owner and loaded by the incoming one before any Session is disturbed.
_Avoid_: migration, failover, rebalance, transfer

**Room Affinity**:
The routing property that sends all Sessions of one Room to the same server instance.
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
- Weak **Room Affinity** increases the rate of **Handovers**; it is not what establishes ownership
- A **Deployment Target** runs many server instances, each with its own **Owner Identity**; whether it can provide **Room Affinity** is a property of the target, not of the server

## Example dialogue

> **Dev:** If routing already sends everyone in a **Room** to the same instance, why do we need the **Room Lock** at all?
>
> **Domain expert:** Because **Room Affinity** is a hint, not a guarantee — the hash ring reshuffles whenever we scale. The **Room Lock** is what actually decides the **Room Owner**. Affinity only decides how often we pay for a **Handover**.
>
> **Dev:** And when a **Handover** happens, do the **Sessions** just get dropped?
>
> **Domain expert:** They get closed, but only after the incoming owner has loaded the **Snapshot** and said it's ready. The clients reconnect into the new owner. If we closed them first, they'd reconnect into a **Room** that nobody owns yet.
>
> **Dev:** One of our **Deployment Targets** can only be sticky per browser, not per **Room**. That's still some affinity, right?
>
> **Domain expert:** No — that's the wrong axis, and it's worse than none. Two people in one **Room** get pinned to two different instances, so each reconnect drags the **Room** back across and evicts the other one. The **Room Lock** still keeps it correct; you just never stop paying for **Handovers**.

## Flagged ambiguities

- "user" was used for both a human collaborator and a **Session** — resolved: one person opening two tabs is two **Sessions**.
- "room" was used for both the durable document and the live in-memory instance — resolved: **Room** is the document; the live instance is held by its **Room Owner**, and its durable form is the **Snapshot**.
- "handover" and "migration" were used interchangeably; "migration" also suggests moving between clouds — resolved: **Handover** only ever means transfer between two server instances of the same demo.
- "Pod Identity" was the term until GCP grew Cloud Run and Compute Engine **Deployment Targets**, where nothing is a pod and its _Avoid_ list ruled out the words those platforms actually use — renamed to **Owner Identity**, which names what the value is for rather than what happens to host it. The code still says `POD_NAME`; that rename is outstanding.
- "example" was used both for a **Deployment Target** and for the sample frontends under `examples/` — resolved: the three directories under `tldraw-sync-gcp/` are **Deployment Targets**.
