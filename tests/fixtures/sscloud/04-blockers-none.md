## P2 — Snapshots

### T17 — Snapshot service + Resource
**Blockers:** none.
**Scope:** `Resource\Snapshot`, `Service\SnapshotService` (`create`, `list`, `restore`, `download`). `create` returns a transfer object; service polls until terminal.
**Acceptance:** Unit + fixture tests covering each method.
