## P1 — Deploy core

### T9 — `sscloud deploy <ref>` MVP
**Status:** In progress — halfway through implementation.
**Blockers:** T8, T13.
**Scope:** Minimal flow: resolve env, trigger deploy with `bypass_and_start` per env config, poll state, render progress.
**Acceptance:**
- `sscloud deploy main --env uat` against a fixture API succeeds end-to-end.
