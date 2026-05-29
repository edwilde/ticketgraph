# T3 — SQLite + migrations infrastructure

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Bring up a `better-sqlite3` database layer with a PRAGMA-correct connection, a lexical migrations runner driven by `PRAGMA user_version`, and an empty `001_init.sql` that lands the real schema in T4.
**Architecture:** `src/db.ts` opens the database, sets PRAGMAs (`journal_mode=WAL`, `foreign_keys=ON`, `synchronous=NORMAL`), runs pending migrations from `src/migrations/*.sql` in lexical order inside a transaction, and updates `user_version` after each file. `src/server.ts` calls `openDb()` during `main()` so the DB is ready before the transport connects. T3 includes a sentinel `tickets._dbinfo` extension to `tickets.ping` is OUT OF SCOPE for this ticket — spec says `db_path`/`schema_version` arrive once the DB layer lands, but the wiring of those fields into ping is bundled with T5's ping rework. Keep T3 tight: db.ts + migrations + tests.
**Tech Stack:** TypeScript ESM, `better-sqlite3@^11`, vitest with per-test temp DB paths.

---

## Ticket-scoped context

- **WAL pragma is set per-connection.** The first connection to a fresh DB sets WAL on disk; subsequent opens use it automatically. Set it explicitly on every connection anyway — cheap, defensive.
- **Foreign keys are OFF by default in SQLite.** Per spec §5, T4's schema relies on FK constraints. Set `PRAGMA foreign_keys = ON` BEFORE any migration runs.
- **`PRAGMA synchronous = NORMAL`** is safe under WAL and faster than FULL. Spec §5 calls it out.
- **`PRAGMA user_version`** is a 32-bit signed integer stored in the database header. Used as the schema version. Starts at 0, incremented per migration file applied. Read with `PRAGMA user_version`, written with `PRAGMA user_version = N`.
- **Migration filename convention:** `NNN_description.sql` where NNN is zero-padded 3 digits. The runner SHOULD `parseInt(name.slice(0, 3))` and apply files where `parsed > current_user_version`.
- **Default DB path:** `~/.claude/tickets.db`. Honour `TICKETGRAPH_DB_PATH` env var.
- **The runner runs migrations inside a transaction PER FILE.** A failure rolls back THAT file's changes only. The `user_version` bump is the last statement of the transaction, so a half-applied file is impossible.
- **Migrations are forward-only.** No `down`. Spec §11 lists no rollback plan; YAGNI.
- **001_init.sql is empty in T3** — the comment block says `-- schema lands in T4`. T3's job is to prove the runner works against an empty migration. T4 fills the file.
- **Tests must NEVER touch `~/.claude/tickets.db`** — set `TICKETGRAPH_DB_PATH` to a per-test temp file (spec §16). Use `mkdtemp` + `path/test.db`.

---

## Task 1: src/migrations/001_init.sql (placeholder)

**Files:**
- Create: `src/migrations/001_init.sql`

**Decisions:**
- File body: a single SQL comment `-- Schema lives in T4. T3 only proves the migrations runner works against this file by bumping user_version to 1.`
- File still counts as a migration; the runner will execute its (empty) contents and bump `user_version` to 1.

**Don't:**
- Don't add any DDL. T4 owns the schema.

**Implement:** Write the placeholder.

**Verify:** File exists, contains the comment, nothing else.

---

## Task 2: Migration runner skeleton

**Files:**
- Create: `src/db.ts`
- Create: `src/db.test.ts`

**Decisions:**
- Public API (this ticket): `openDb(options?: { path?: string; readonly?: boolean }): Database.Database`. Returns the open, migrated, PRAGMA-set handle.
- Path resolution: `options.path ?? process.env.TICKETGRAPH_DB_PATH ?? join(os.homedir(), ".claude", "tickets.db")`. Ensure parent dir exists (`mkdirSync(..., { recursive: true })`) — common first-run failure mode otherwise.
- PRAGMA order (matters!): `journal_mode=WAL` → `foreign_keys=ON` → `synchronous=NORMAL`. Apply BEFORE migrations so FK enforcement is in effect during DDL.
- Migrations: read files from `src/migrations/` (resolved from `dist/migrations/` at runtime — see Task 3 about bundling). Sort lexically by filename. For each file whose `NNN` > current `user_version`, run the SQL and bump `user_version` to `NNN` inside one transaction (`db.transaction(() => { db.exec(sql); db.pragma('user_version = ' + n); })()`).
- Log via `logger.info("migrations: applied N (user_version=N)", { applied, version })`. Even if N=0 (nothing to apply), log once at startup.
- Error handling: if a migration's SQL throws, the transaction rolls back; the runner re-throws with context (`Error: migration 002_xxx.sql failed: <original>`).
- Concurrency: `better-sqlite3` uses `BEGIN IMMEDIATE` by default for transactions, which serialises against other writers. Acceptable per spec §13.

**Don't:**
- Don't open the DB with `verbose: console.log` — would dump SQL to stdout and corrupt MCP framing. If verbose logging is ever needed, route through `logger.error` or skip entirely.
- Don't run migrations outside a transaction; partial application is the single biggest failure mode.
- Don't accept `down` migrations or down-files — forward-only.
- Don't migrate when `options.readonly` is true. Throw if `user_version < expected` and someone tries to read-only-open a stale DB; that's an upgrade-needed error.

**Implement:** `openDb()` with PRAGMAs, migrations runner, structured logging.

**Verify:** Tests in Task 4.

---

## Task 3: Migrations bundling

**Files:**
- Modify: `tsup.config.ts`
- Modify: `package.json` (add a build step to copy migrations OR adjust tsup config)

**Decisions:**
- The migration SQL files are NOT TypeScript — tsup won't bundle them. Two options:
  1. **Copy** `src/migrations/*.sql` to `dist/migrations/*.sql` after build via a postbuild script.
  2. Read migrations at runtime from a path resolved relative to `import.meta.url`, falling back to `src/migrations` in dev or `dist/migrations` in production.
- Pick option 1 — copy via tsup's `onSuccess` hook (`onSuccess: async () => { /* cp -R src/migrations dist/migrations */ }`). Keeps the runtime resolution single-rooted.
- Migrations directory resolution in `db.ts`: `resolve(fileURLToPath(import.meta.url), "..", "migrations")` — works for both dev (`src/migrations`) and prod (`dist/migrations`).
- Test invocation: tests import the TS source directly via vitest's loader, so `import.meta.url` resolves to `src/db.ts` and finds `src/migrations`. Built artifact resolves to `dist/db.js` and finds `dist/migrations`.

**Don't:**
- Don't `import.meta.glob` — that's bundler-specific. Use `readdirSync(migrationsDir)`.
- Don't read migrations as JS modules. They're SQL strings.

**Implement:** Update `tsup.config.ts` with an `onSuccess` hook that calls `fs.cpSync('src/migrations', 'dist/migrations', { recursive: true })`. Verify `dist/migrations/001_init.sql` exists after `npm run build`.

**Verify:** `npm run build && ls dist/migrations/001_init.sql` → exit 0.

---

## Task 4: Unit tests for migrations runner

**Files:**
- Create or expand: `src/db.test.ts`

**Decisions:**
- Every test uses `mkdtempSync` + `path/test.db` for full isolation. No test reads or writes the real `~/.claude/tickets.db`. afterEach removes the temp dir.
- Required cases (spec acceptance):
  1. **Fresh DB creates user_version=1.** Open a brand-new DB path; after `openDb()`, `PRAGMA user_version` returns 1.
  2. **Idempotent re-run.** Call `openDb()` twice on the same path; `user_version` stays 1; no error.
  3. **Migration ordering.** Drop a `002_test.sql` (creates a known empty table) into the migrations dir for the duration of the test (use a fake migrations dir via an injected option). Confirm `001` runs before `002` regardless of insertion order on disk.
  4. **Transaction rollback on SQL error.** Inject a migration with intentionally bad SQL; assert: (a) the SQL throws, (b) `user_version` did NOT bump, (c) any side-effect tables from the bad migration do not exist.
  5. **PRAGMAs are set.** `PRAGMA journal_mode` returns `wal`, `PRAGMA foreign_keys` returns 1, `PRAGMA synchronous` returns 1 (NORMAL).
  6. **TICKETGRAPH_DB_PATH respected.** Set env var, call `openDb()` with no path arg, confirm the file at the env-var location is created.
- For tests that need a different migrations directory (cases 3 and 4), the simplest design is to support an internal `_migrationsDir` option on `openDb()` — undocumented public API but typed and reachable from tests. Mark with a JSDoc `@internal`.

**Don't:**
- Don't share a single DB across tests. Each test gets its own temp.
- Don't shell out to `sqlite3` CLI to verify — `better-sqlite3` has all the introspection you need.

**Implement:** Six tests in `src/db.test.ts`. Each opens its own temp DB. Migration-dir-injection tests use `_migrationsDir` option.

**Verify:** `npm test src/db.test.ts` → 6/6 passing.

---

## Task 5: Wire openDb() into the server bootstrap

**Files:**
- Modify: `src/server.ts`

**Decisions:**
- In `main()`, after `getPackageVersion()` and before `new Server(...)`, call `const db = openDb()` and log `"db opened"` with the resolved path. Store the handle on a module-level constant accessible to tools (`let db: Database.Database | null = null; openDb(...) → db = ...`).
- Tools registered later (T5+) will import the handle. T3 only proves the bootstrap path: server starts → migrations apply → server serves.
- `tickets.ping` continues to return `{ ok: true, version }` for now. The `db_path` / `schema_version` fields are deferred to T5 along with the rest of the read tools (so they land at the same time as the project resolution machinery — keeping ping's surface minimal until then).
- Shutdown: `db.close()` BEFORE `server.close()`. Better-sqlite3 doesn't strictly need explicit close on process exit, but doing it lets us assert clean shutdown.

**Don't:**
- Don't add `db_path` / `schema_version` to ping in T3 — that's T5.
- Don't make `db` a top-level top-of-file `const`. It must initialize inside `main()` so `--help` doesn't open the DB.
- Don't open the DB in tools' module bodies — they get the handle from the server, lazily.

**Implement:** Update `src/server.ts` `main()` to call `openDb()`, store the handle, close it on shutdown.

**Verify:** Integration test in Task 6.

---

## Task 6: Integration test — server bootstraps with migrations applied

**Files:**
- Create: `tests/server.bootstrap.test.ts`

**Decisions:**
- Spawn the built server with `TICKETGRAPH_DB_PATH=$tmp/test.db` set in `env`. After the server logs "ticketgraph starting", verify (a) the DB file was created, (b) opening it with `better-sqlite3` from the test and reading `PRAGMA user_version` returns 1.
- Verifies the bootstrap chain end-to-end: spawn → openDb → migrations → log → ready. Earlier unit tests cover the in-process path; this test covers the OUT-of-process path (the way a real client invokes the server).
- One test case is enough — the unit tests have already covered the runner's edge cases.

**Don't:**
- Don't share the temp DB across tests in this file. The whole point is isolation.
- Don't run any tool calls in this test — that's the stdio test's job. Just prove bootstrap.

**Implement:** Spawn server, wait for startup log, signal SIGTERM, assert exit 0, then open the DB file and assert `user_version = 1`.

**Verify:** `npm test tests/server.bootstrap.test.ts` → 1/1 passing.

---

## Task 7: Full acceptance gate

**Files:** (none — verification only)

**Decisions:**
- All acceptance criteria from `.ai/TICKETS.md` T3 must pass.

**Verify:**
1. `npm run build` → exit 0; `dist/server.js` and `dist/migrations/001_init.sql` both exist.
2. `npm test` → exit 0; all tests green.
3. `npm run typecheck` → exit 0.
4. `node dist/server.js --help` → exit 0 (regression check).
5. Spawn server with a temp DB path, observe stderr log `migrations: applied 1 (user_version=1)` or `applied 0` on rerun.
6. `grep -rn 'console\.' src/ tests/` → 0 hits.

---

## Caveats & known risks

- **Native build risk:** `better-sqlite3@11` requires node-gyp + Python at install time. T1 already validated the build works locally; CI (T13) is the long-term canary. If `npm install` ever fails here, pin to a specific better-sqlite3 version and re-install.
- **`fs.cpSync` is Node 16.7+** — well within our Node 20 floor. No polyfill.
- **Pragmas read with mixed casing:** `db.pragma('user_version')` returns a number when the value is unambiguous; we read via `db.pragma('user_version', { simple: true })` to get a primitive directly.
- **Foreign keys ON before migrations:** if a future migration adds rows that violate FKs (T4's schema does have FKs), they must respect the constraint. T3's migration is empty, so this is forward-looking but worth stating.
- **migrations directory absent in dev mode:** if a future contributor runs `npm test` after deleting `src/migrations/`, the runner should give a clear error, not crash. The runner reads the dir; if it doesn't exist, throw `Error: migrations dir not found: <path>`.
- **`TICKETGRAPH_DB_PATH` for tests is critical** — never let `openDb()` fall through to `~/.claude/tickets.db` in a test. Defensive code: a `process.env.NODE_ENV === "test"` check that warns if path resolves to homedir; defer unless we ship a footgun.

---

## Validation review

(none — moderate ticket but no novel architecture. Sibling: many Node SQLite migration runners exist; behaviour is well-known. Verification harness is a pair of tests + integration spawn — already used in T2.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier subagent, fresh context)
**Branch:** main (T3 unstaged at review time)

### Verification Results
- `npm run build` → exit 0; `dist/server.js` 6.98 KB; `dist/migrations/001_init.sql` present.
- `npm test` → exit 0; **20/20 tests** across 7 files (logger 3, version 2, ping 3, db 6, stdio 3, shutdown 2, bootstrap 1).
- `npm run typecheck` → exit 0.
- `node dist/server.js --help` → exit 0; does NOT open the DB.
- Stderr log first start: `migrations: applied 1 (user_version=1)`. Rerun: `applied 0`.
- `grep -rn 'console\.' src/ tests/` → 0 hits.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | All 23 acceptance criteria | Completed as planned | — |
| 2 | Rollback test could be airtight with a single-statement failure | Suggested (test style) | Deferred — current test verifies atomicity correctly (partial table + user_version both checked); style preference, not correctness |
| 3 | Bootstrap test waits for `ticketgraph starting` rather than `migrations: applied` | Suggested (test robustness) | Deferred — under WAL + synchronous=NORMAL the race window is theoretical; revisit if test flakes on CI |
| 4 | Two `import ... from "node:fs"` statements in `src/db.ts` | Nit | Deferred — cosmetic |
| 5 | Log message uses string concat instead of template literal | Nit | Deferred — cosmetic |

### Technical Context & Learnings
- **Better-sqlite3 transaction semantics**: `db.transaction(fn)()` wraps the inner function in `BEGIN IMMEDIATE` / `COMMIT`, so any throw inside (including from `db.exec()`'s multi-statement parser) rolls back the entire batch. The current rollback test relies on this and proves it works.
- **PRAGMA order matters for FK enforcement**: applying `journal_mode=WAL` before `foreign_keys=ON` is the canonical order; FKs are then enforced for every subsequent statement, including migrations.
- **Migration directory resolution via `import.meta.url`** works for both dev (TS via vitest resolves `src/migrations`) and prod (built `dist/db.js` resolves `dist/migrations`). The tsup `onSuccess` `cpSync` copies the SQL files at build time — bypassing this would break the prod path.
- **`_migrationsDir` internal injection** is the testing chokepoint: any future migration runner tweak (ordering, format) can be tested without touching the on-disk `src/migrations/` directory.

### Items Requiring Rework
None.

### Deferred/Skipped Items
- Test-style hardening (single-statement rollback case, migrations-applied wait in bootstrap test). Both deferred unless they cause real flakes.
