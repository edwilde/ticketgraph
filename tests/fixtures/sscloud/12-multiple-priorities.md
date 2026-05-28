## P0 — Foundation

### T1 — Project scaffold
**Status:** ✅ Done — commit `abc123`.
**Blockers:** none.
**Scope:** Bootstrap the project.
**Acceptance:** `composer install` clean.

## P2 — Snapshots

### T17 — Snapshot service + Resource
**Blockers:** none.
**Scope:** `Resource\Snapshot`, `Service\SnapshotService`.
**Acceptance:** Unit + fixture tests.

## P3 — Future features

### T40 — Parsed-log deploy progress bar
**Blockers:** T8, T13.
**Scope:** Detect milestone phrases from the deploy log stream.
**Acceptance:** Manual: a real deploy on gdsnz UAT shows a bar.
