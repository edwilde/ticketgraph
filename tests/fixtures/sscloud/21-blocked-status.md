## P1 — Deploy core

### T12 — `AutoSnapshotPolicy`
**Status:** Blocked on T17 (snapshot service not yet shipped).
**Blockers:** T10, T17.
**Scope:** Pre-action policy; calls `SnapshotService::create()` with the configured mode (`db|all|assets`). Skipped with `--no-snapshot`.
**Acceptance:** Test covers skip flag, mode propagation, and failure.
