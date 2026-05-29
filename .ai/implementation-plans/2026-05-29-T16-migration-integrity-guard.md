# T16 — Migration runner: detect & clearly report a version-ahead-of-schema DB

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** When a database reports a schema `user_version ≥ 1` but is missing the expected tables (a half-initialised / version-ahead-of-schema DB), `openDb()` must fail immediately with a clear, actionable error — instead of letting the first tool that touches a table fail much later with a cryptic `no such table: projects`.
**Architecture:** A single O(1) `sqlite_master` sentinel-table check added to `src/db.ts`'s `openDb()`, applied on both the write path (after `applyMigrations`) and the read-only path (after the stale-migration check). No schema change, no auto-repair.
**Tech Stack:** TypeScript ESM, better-sqlite3. No new deps.

---

## Ticket-scoped context

- **The bug** (found 2026-05-29 during a live migration): a `~/.claude/tickets.db` created during the T3→T4 dev window had `user_version=1` (empty placeholder 001 bumped it) but zero tables (real schema landed later in T4, and the filled 001 won't re-run because version is already 1). `register_project` then failed with `no such table: projects`. Not recurring for fresh clones (001 is now the full schema), but the runner has no guard against a version/schema mismatch from ANY cause (interrupted migration, hand-edited DB, future partial migration).
- **`openDb()` structure** (`src/db.ts`): sets PRAGMAs → if `readonly`, does a stale-migration check and returns → else `applyMigrations(db, migrationsDir)` → returns `{ db, dbPath }`. The guard goes:
  - **write path:** immediately after `applyMigrations(...)` returns.
  - **read-only path:** after the existing stale-migration check passes (a readonly open of a half-init DB at version 1 with 0 pending migrations passes the stale check today but still has no tables).
- **Sentinel table: `projects`.** It's the root table every project/ticket depends on (FKs cascade from it). If `user_version ≥ 1` and `projects` is absent from `sqlite_master`, the DB is in an invalid state.
- **Check is O(1):** `SELECT name FROM sqlite_master WHERE type='table' AND name='projects'`. Only run it when `user_version ≥ 1` (a fresh `user_version=0` DB legitimately has no tables before migration; but after `applyMigrations` on a fresh DB, version becomes 1 and tables exist, so the post-migration check covers it).
- **Error message** must name the path and the likely cause + the remedy, e.g.:
  `Database at <path> reports schema version <N> but is missing the expected 'projects' table. This usually means it was created by a pre-release build or a migration was interrupted. Back it up if it holds data, delete it, and restart to re-initialise.`
- **Do NOT auto-delete or auto-repair** — the DB may hold real data; surface the problem and let the operator decide.
- **Error type**: `openDb` already throws plain `Error` for the stale-readonly case — match that (plain `Error`, not `McpError`; `openDb` is infra, called before the MCP layer). The server's `main().catch` already logs fatal + exits; tools never call `openDb` directly.
- **Logging**: the existing `migrations: applied N` info log stays. The guard throws before returning; no extra logging needed (the thrown error is logged by the caller).

---

## Task 1: integrity guard helper + wiring

**Files:**
- Modify: `src/db.ts`

**Decisions:**
- Add `function assertSchemaIntact(db, dbPath): void`:
  - `const version = db.pragma("user_version", { simple: true }) as number;`
  - if `version >= 1`:
    - `const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();`
    - if `!row` → `db.close(); throw new Error("Database at " + dbPath + " reports schema version " + version + " but is missing the expected 'projects' table. ...remedy...")`.
- Call `assertSchemaIntact(db, dbPath)`:
  - write path: right after `applyMigrations(db, migrationsDir);`, before `return`.
  - read-only path: right after the stale-migration `if (pendingCount > 0)` block, before `return { db, dbPath }`.
- `db.close()` before throwing so the handle doesn't leak.

**Don't:**
- Don't run the check when `version === 0` (a pre-migration fresh DB legitimately has no tables; the write path migrates it first then checks).
- Don't auto-delete/repair.
- Don't change the migration-application logic or the stale-readonly check.
- Don't use a different sentinel than `projects` (it's the FK root).

**Implement:** Add the helper + two call sites.

**Verify:** Unit tests in Task 2.

---

## Task 2: tests

**Files:**
- Modify: `src/db.test.ts`

**Decisions:**
- Reuse the existing `mkdtempSync` temp-DB pattern.
- Cases:
  1. **Half-init DB (write path) → clear throw.** Fabricate a DB: open raw `better-sqlite3`, `PRAGMA user_version = 1`, create NO tables, close. Then `openDb({ path })` → throws `/missing the expected 'projects' table/`. (The runner sees version 1, 0 pending migrations since the real 001 is version 1, so it applies nothing and the guard fires.)
  2. **Normal DB → no throw.** `openDb({ path })` on a fresh path → migrates → `projects` exists → returns a handle; a follow-up `openDb` on the same path also fine.
  3. **Fresh DB (version 0) → migrates then passes.** Covered by case 2's first open (version 0 → 1 with tables).
  4. **Read-only half-init → clear throw.** Fabricate the version-1-no-tables DB, then `openDb({ path, readonly: true })` → throws the same guard error (after the stale check, which passes because 0 pending).
- The existing migration tests (ordering, rollback, idempotency, PRAGMAs, env path) must stay green — the guard only adds a check, it doesn't change application.

**Don't:**
- Don't touch `~/.claude/tickets.db` — temp DBs only.
- Don't assert on exact full message text — match the key phrase (`/missing the expected 'projects' table/`) so wording can be tuned.

**Implement:** The cases above.

**Verify:** `npm test src/db.test.ts` → all green (existing + new).

---

## Task 3: Full gate

**Verify:**
1. `npm run build` → exit 0.
2. `npm test` → exit 0; all green (run twice — the suite is timing-stable; don't reintroduce flakes).
3. `npm run typecheck` → exit 0.
4. `node dist/server.js --help` → exit 0.
5. `grep -rn 'console\.' src/ tests/` → 0 hits.

---

## Caveats & known risks

- **Sentinel choice**: `projects` is the right sentinel — it's the FK root and the first thing `register_project` needs. If a future migration renames it, update the sentinel.
- **`version >= 1` gate**: must not fire on a fresh `version=0` DB before migration. The write path migrates first (→ version 1 + tables) then checks, so a fresh DB passes. Only a DB that was *left* at ≥1 without tables trips it.
- **Read-only path**: the existing stale check catches "version behind the migration files"; the new guard catches "version at/ahead of files but tables missing" — different failure, both now covered.
- **Not a substitute for the migration transaction guarantee**: migrations are still all-or-nothing per file. This guard catches DBs that reached a bad state by other means (the T3→T4 artifact, hand edits, a future interrupted run).
- **No auto-repair by design** — deleting a user's DB automatically would be destructive; the error tells them what to do.

---

## Validation review

(none — a single defensive check; the only subtlety is the `version >= 1` gate and the two call sites, both covered by tests.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier subagent, fresh context)
**Branch:** feat/t16-t17-post-v0.1.0

### Verification Results
- `npm run build` → exit 0. `npm test` → exit 0; **414/414** (was 410; +4). `npm run typecheck` → 0. `--help` → 0. `grep console.` → 0.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | All 12 criteria (guard logic, both call sites, version≥1 gate, plain Error, no auto-repair, 4 tests) | Completed as planned | Verified |
| 2 | Guard skipped when `_migrationsDir` is set (test-only `@internal` hatch) | Deviation | Approved — sound: the toy-schema migration tests don't create `projects`, so the guard would false-fail them; the half-init tests fabricate the bad DB raw and call `openDb({path})` WITHOUT `_migrationsDir`, so the guard IS exercised via the real production path (not vacuous) |

### Technical Context & Learnings
- `assertSchemaIntact` runs after migrations (write) and after the stale check (readonly). Sentinel = `projects` (FK root). O(1) `sqlite_master` lookup, gated on `user_version >= 1`. Closes the handle and throws a clear plain `Error` (path + version + cause + remedy); never auto-repairs.
- The `_migrationsDir` bypass is the right seam: it's the existing `@internal` test escape hatch, never used in production, and the guard's own tests deliberately avoid it so they hit the real path.
- Readonly half-init test needed the fabricated DB created in WAL mode so the readonly `openDb`'s `journal_mode = WAL` pragma doesn't fail on a non-WAL file — a real gotcha for readonly SQLite opens.

### Items Requiring Rework
None.

### Deferred/Skipped Items
None.
