# Per-cloud demos duplicate the server rather than sharing it

`tldraw-sync-gcp/` and `tldraw-sync-aws/` contain byte-identical copies of `roomManager.ts`, `index.ts`, `metrics.ts`, `unfurl.ts` and both frontends; the only application-level difference is the storage module (`gcsStorage.ts` vs `s3Storage.ts`). We chose this over the obvious alternative — a shared `sync-core` package with thin per-cloud adapters, wired up as Yarn workspaces — because these are reference demos whose primary job is to be read and copied. Someone evaluating the AWS story should be able to take `tldraw-sync-aws/` on its own, `yarn install`, and run it, without discovering that the interesting logic lives in a sibling package they also need.

## Consequences

The duplicated ~800 LOC will drift: a fix to the handover protocol in one demo does not reach the other. Treat cross-porting as a deliberate step when touching `roomManager.ts`, and keep the storage module the _only_ intentional difference — if a second file starts to diverge for cloud reasons, that is the signal to revisit this decision.
