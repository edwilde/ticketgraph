## P1 — Deploy core

### T9 — `sscloud deploy <ref>` MVP
**Blockers:** T8, T13 (deploy renderer can be developed in parallel; deploy command imports it).
**Scope:** Minimal flow: resolve env, trigger deploy.
**Acceptance:**
- `sscloud deploy main --env uat` against a fixture API succeeds end-to-end.
- `--non-interactive` works.
