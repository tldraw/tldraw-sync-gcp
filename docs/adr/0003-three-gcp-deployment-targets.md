# The GCP demo is three deployment targets, each with its own copy of the server

`tldraw-sync-gcp/` was named for a cloud but only ever demonstrated one way of running on it: every artefact in it was GKE-specific. It is now a container for three Deployment Targets — `tldraw-sync-gke/`, `tldraw-sync-cloud-run/` and `tldraw-sync-compute-engine/` — and each holds its own complete copy of the server, tests, Dockerfile and example clients, exactly as the two per-cloud demos already do.

We verified that the application needs no change to run on any of them. `PORT` is read from the environment, the listener binds all interfaces, GCS access is ADC and so works identically under Workload Identity, a Cloud Run service account and a GCE instance service account, and the only Kubernetes-flavoured environment variable — `HOSTNAME`, the base of the Owner Identity — is optional, because a random suffix supplies uniqueness regardless. The container image is identical for all three. **The difference between the targets is entirely packaging, infrastructure and operational trade-offs.**

That fact is also the strongest argument for the alternative we rejected: one shared `server/` package with three infrastructure-only sibling directories. It would be cheaper to maintain, and it would make "the code does not change" visible in the layout rather than only in prose. We chose duplication anyway, for the reason ADR 0001 gives: a reference demo's job is to be read and copied, and someone evaluating Cloud Run should be able to take `tldraw-sync-cloud-run/` on its own, `yarn install`, and run it, without discovering that the interesting logic lives in a sibling they also need. Applying that principle per cloud but not per target would have been inconsistent.

## Consequences

Cross-porting is now a **four-way** obligation rather than a two-way one: a change to `roomManager.ts` must land identically in `tldraw-sync-aws/` and in all three GCP targets. `c63e8be` is the model — one concern, applied symmetrically, identical line counts everywhere. CI builds and tests each copy independently but **cannot** detect a missed cross-port; only review can, which is why `.cursor/BUGBOT.md` names it explicitly.

This is the cost ADR 0001 accepted, multiplied. If it becomes unmanageable, the escape route is the rejected alternative above, and the trigger is drift: two copies of a shared file differing for any reason other than the storage module.

The tripwire, mirroring ADR 0001's: if a target ever requires a genuine code change — a different base image, a platform-specific Owner Identity source, a Cloud-Run-specific shutdown handler — that is the signal to revisit this record rather than to quietly fork a file.

By default each target provisions its own VPC, Memorystore instance, GCS bucket and Artifact Registry repository, so it deploys end-to-end from a single apply. Memorystore is the dominant line item, so deploying all three that way means paying for it three times; every target therefore takes `create_substrate = false` plus `existing_*` variables. Sharing one substrate also enables the clearest demonstration in the repo: point two targets at one Redis, open the same room against both, and watch a **Handover across Deployment Targets** as a GKE pod hands the Room to a COS VM. Room Ownership is a property of the Room Lock, not of the platform.

`CONTEXT.md` renames **Pod Identity** to **Owner Identity**, because the old term's _Avoid_ list ruled out the correct words for two of the three targets. The code still says `POD_NAME`; until that rename lands and is cross-ported, the glossary and the source disagree.

`tldraw-sync-gcp/` and `tldraw-sync-aws/` are no longer structurally symmetric — AWS is a package root, GCP is a container. That is the right asymmetry: GCP genuinely has three targets and AWS has one, and forcing AWS into a container it does not need would be structure for symmetry's sake. If AWS gains an ECS or App Runner target it nests the same way.
