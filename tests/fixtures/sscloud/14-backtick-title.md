## P1 — Deploy core

### T14 — `deploy:status`, `deploy:promote`, `deploy:redeploy`
**Blockers:** T8, T10.
**Scope:**
- `deploy:status [<id>]` — last deploy or specified id.
- `deploy:promote <from> <to>` — uses `ref_type: promote_from_uat`.
**Acceptance:** Each has tests covering happy path and policy gating.

### T7 — `sscloud stack:list` and `stack:info`
**Blockers:** T2.
**Scope:** Read-only commands; both have `--json` mode.
**Acceptance:** Snapshot tests for human and JSON output; tests against a fixture API.
