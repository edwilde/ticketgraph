## P1 — Rollback

### T30 — `sscloud rollback`
**Blockers:** T8, T10, T11, T22.
**Scope:** Code-only rollback. Re-deploys the previous successful ref to an environment.

**Resolution algorithm:**
1. List recent deploys for the target env.
2. Identify the bad deploy: the most recent `Completed` deploy.
3. 3-hour window check: the bad deploy must have completed within the last 3 hours.

**Acceptance:**
- Unit tests for the resolution algorithm cover: happy path, no prior deploy, bad deploy too old.
- Production rollback refuses without typed env name confirmation.
- `--dry-run` works without authentication side-effects.
