# ticketgraph — Development Tickets

Each ticket is self-contained. Build with `/writing-plans` → `/subagent-driven-development` → `/review-implementation`. TDD throughout — testing contract is **§16 of the design spec** (three layers, version-controlled fixtures, every Acceptance bullet maps to a named test).

**Priority levels:** P0 must ship before anything else; P1 is v1 MVP; P2 is v1 polish; P3 is v1.1+.
**Read first:** `docs/specs/2026-05-28-ticketgraph-design.md`.

## Ticket status (live)

| Done ✅ | In progress | Open |
|---|---|---|
| T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15, T16, T17, T18, T19, T20, T21, T22, T23, T24, T25, T26, T28 | _(none)_ | T27 |

**T1–T18 complete (2026-05-29).** 410 tests across 42 files, deterministically green (verified 12/12 consecutive full-suite runs). 21 MCP tools, demo + sample parsers (both 100% heading parse on the live files), plugin manifest + install docs, README + usage + migration docs, and GitHub Actions CI (ubuntu + macOS).

**T19, T20 (user-requested, 2026-05-29):** batch ticket creation (`tickets.add_many`) and a token-efficiency review of tool response shapes — both motivated by batch-add sessions where N single `tickets.add` calls each echo a full ticket row back.

**T21 (user-requested, 2026-05-30):** `tickets.export` — a timestamp-stamped, banner-labelled `.ai/TICKETS.md` snapshot. Consciously reverses the spec's "no markdown export / TICKETS.md not regenerated" non-goal; the loud generated-at banner is the drift mitigation that earns the reversal.

**T20 landed (2026-06-03, four-stage pipeline):** lean default response shapes — write tools (`add`/`update`/`set_parent`/`append_to_description`) now return a lean flat shape by default with the full row via `full: true`, and `tickets.get` omits `recent_audit` unless `include_audit: true`. Measured default-shape byte reductions: add −73%, update −68%, set_parent −84%, append −80%, get −76%. No datum unrecoverable (opt-in restores it). 643 tests green. Findings: `.ai/2026-06-03-T20-response-shape-findings.md`; plan + review record: `.ai/implementation-plans/T20-token-efficiency-response-shapes.md`. **Key learning:** token cost is path-dependent — extra fields are free on the CLI *compact* path (6 columns rendered) but billed in full on the MCP / `--format json` path; trimming `TResult` is the only lever for the JSON/MCP paths.

**T28 landed (2026-06-04, v0.6.0, four-stage pipeline):** added the `ticketgraph mcp` launch command (additive disjunct in `server.ts:110`; `--mcp`/no-args unchanged and regression-tested) and restructured the README CLI-first with the MCP demoted to an opt-in section. `--help` footer + `docs/install.md` document `mcp` as preferred. `mcp` stays an entry-switch *mode* (never routed through `runCli`), so it ignores trailing flags. 646 tests green; plan + review record in `.ai/implementation-plans/T28-mcp-command-and-cli-first-readme.md`. Tagged v0.6.0 with a GitHub release.

**T27 (user-requested, 2026-06-03):** reduce the token cost of the common "outstanding tickets" read path. A real session burned ~3k tokens / 9 Bash calls to answer it, because (a) compact `get` renders the list row and hides the description, (b) repeated `--id` silently last-wins instead of multi-fetching, and (c) the one-call path (`list --include_description`) is undiscoverable. Token efficiency is again the driver — same mission as T20/T22–T26, now on the *read* round-trip rather than the response shape.

**T22–T26 (user-requested, 2026-05-31):** a CLI surface so every tool runs **either via MCP or `ticketgraph <command>`** — reversing the spec's "no CLI" YAGNI non-goal (§5, and the P3 "CLI surface" deferral). **Token efficiency is the driver, and the real win is structural:** the MCP injects all 23 tool schemas into *every* connected session (~2–4k tokens of always-on context tax, paid whether or not tickets are touched). A CLI invoked via Bash costs ~0 context until used. The plan therefore makes the **CLI the default and the MCP opt-in** (decision 2026-05-31), keeping always-on cost to a one-line `CLAUDE.md` pointer + on-demand `--help`. Cheap to build because every tool is already a pure `Tool<TArgs,TResult>` (`parseArgs → handle → plain data`); the CLI is a second thin front-end over the same `makeToolRegistry`, not a rewrite. Decisions locked 2026-05-31: **dual-mode single bin** (no args / `--mcp` → stdio server; `ticketgraph <command>` → CLI), **CLI default + MCP opt-in**, **compact-text default output** (`--format json` retained). **Landed 2026-05-31 (v0.4.0):** all five tickets built via the four-stage pipeline (writing-plans → devils-advocate → subagent-driven-development → review-implementation; per-ticket records in `.ai/implementation-plans/2026-05-31-T2[2-6]-*.md`). 628 tests across 55 files, deterministically green; dual-mode verified end-to-end with the MCP off. `.mcp.json` removed (MCP now opt-in — restore + `/reload-plugins` to re-enable); compact output measured ~81% smaller than JSON on multi-row lists.

**T14 (user-requested):** roots-based project resolution — a global server's `process.cwd()` is its spawn dir, not the user's active project, so cwd auto-scoping now resolves from MCP client roots (with cwd fallback).

**MVP milestone (earlier 2026-05-29):** add / read / mark-completed loop via `tickets.add`, `tickets.list` / `tickets.get` / `tickets.stats`, `tickets.update { patch: { status: "done" } }`.

Each ticket ran the four-stage dream-skills pipeline (writing-plans → subagent-driven-development → two-stage review → review-implementation); plans + as-built review records live in `.ai/implementation-plans/2026-05-29-T*.md`.

---

## P0 — Foundation

### T1 — Project scaffold
**Status:** Open.
**Blockers:** none.
**Scope:**
- `package.json` — name `@edwilde/ticketgraph`, type `module`, Node `>=20`. Bin entry `ticketgraph` pointing at the built MCP server.
- Dev dependencies: `typescript`, `tsup` (build), `vitest` (tests), `@types/node`.
- Runtime dependencies (placeholders, wired in later tickets): `@modelcontextprotocol/sdk`, `better-sqlite3`.
- `tsconfig.json` — strict mode, ES2022 target, NodeNext module resolution.
- `tsup.config.ts` — single ESM bundle, sourcemaps.
- `vitest.config.ts` — Node environment, coverage off by default.
- `.gitignore` — `node_modules`, `dist`, `*.db`, `*.db-journal`, `coverage`, `.DS_Store`.
- `.editorconfig`, `.prettierrc` — match Ed's standard formatting.
- `LICENSE` — MIT.
- Root `README.md` stub (one-paragraph project description + link to the design spec).
**Acceptance:**
- `npm install` clean.
- `npm run build` produces `dist/server.js` (empty stub is fine).
- `npm test` runs (zero tests pass).
- `node dist/server.js --help` returns a usage stub without crashing.

### T2 — MCP stdio server skeleton
**Blockers:** T1.
**Scope:**
- `src/server.ts` boots `@modelcontextprotocol/sdk`'s stdio server.
- Server registers a single `tickets.ping` tool that returns `{ ok: true, version }` — minimal end-to-end smoke test.
- Server logs startup + tool calls to stderr at info level (stdout reserved for MCP protocol).
- Graceful shutdown on SIGTERM / SIGINT.
- Vitest harness that spawns the built server, sends an MCP `initialize` + `tools/call ping` over stdio, asserts the response shape.
**Acceptance:**
- `claude mcp add ticketgraph -s user -- node /path/to/dist/server.js` succeeds.
- From a Claude session, `tickets.ping()` returns `{ ok: true, version: "0.1.0" }`.
- Vitest stdio smoke test green.

### T3 — SQLite + migrations infrastructure
**Blockers:** T1.
**Scope:**
- `src/db.ts` — opens `better-sqlite3` against the path from `TICKETGRAPH_DB_PATH` env var, defaulting to `~/.claude/tickets.db`.
- Sets `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, `PRAGMA synchronous = NORMAL`.
- Migrations runner reads `src/migrations/*.sql` lexically, applies any with version > `PRAGMA user_version`, increments user_version per file inside a transaction.
- Migration filename convention: `NNN_description.sql` where NNN is zero-padded 3-digit version.
- Empty `001_init.sql` (real schema lands in T4).
- Unit tests cover: fresh-DB creates user_version=1, idempotent re-run, migration ordering, transaction rollback on SQL error.
**Acceptance:**
- Server starts, opens DB, applies migrations, logs `migrations: applied N (user_version=N)`.
- Re-running migrations is a no-op.
- Tests cover the four cases above.

### T4 — Schema 001_init.sql
**Blockers:** T3.
**Scope:**
- Implements the full schema from design spec §5: `projects`, `tickets`, `relations`, `tags`, `tickets_fts`, `audit_log`, plus all indexes.
- FTS5 sync triggers: `INSERT/UPDATE/DELETE` on `tickets` keeps `tickets_fts` in lockstep. Triggers test-covered.
- `closed_at` auto-set trigger: when `status` moves to `done` or `deferred`, set `closed_at = now()` if NULL; when moving back to non-terminal, clear it. (Audit-log update covers the trail.)
**Acceptance:**
- Schema applies cleanly on fresh DB.
- Round-trip test: insert a ticket, search via FTS, update title, search again, assert FTS reflects the update.
- Status-transition tests cover the `closed_at` trigger in both directions.

## P1 — MVP tool surface

### T5 — Read tools: register_project, list, get, stats
**Blockers:** T4.
**Scope:**
- `tickets.register_project({ id, display_name, root_path })` — validates UNIQUE(id), UNIQUE(root_path); returns the new project record.
- `tickets.list({ project?, status?, priority?, type?, epic?, parent_id?, tag?, blocked_by?, created_after?, include_description?, limit?, offset? })` — default `status IN ('open','in_progress','blocked')`, default `limit=50`. Returns summary rows only unless `include_description: true`.
- `tickets.get({ project?, id | ids })` — full ticket(s) including relations grouped by direction and kind, last 10 audit entries.
- `tickets.stats({ project? })` — counts grouped by status / priority / epic / type. Total response <100 tokens.
- `tickets.add({ project?, id?, title, description?, status?, priority?, type?, epic?, parent_id?, created_by?, tags? })` — manual create. Auto-assigns next id within the project's numbering scheme when `id` omitted; numbering scheme inferred from existing tickets (`T<n>`, `SETUP-<n>`, etc.) with fallback `T<n>`.
- Project resolution: explicit `project` param overrides; otherwise resolve from cwd by walking up to the nearest matching `projects.root_path`. If no match, return a clear error pointing at `tickets.register_project`.
**Acceptance:**
- All five tools callable from Claude via MCP, return shapes match the spec.
- Token budgets met against a seeded 100-ticket fixture: list <1500, get <2000 per ticket, stats <100.
- `tickets.list` excludes done/deferred by default; explicit `status: "all"` returns everything.
- Tests cover: cwd resolution, explicit project override, numbering scheme inference, validation errors.

### T6 — Search tool with FTS5
**Blockers:** T4, T5.
**Scope:**
- `tickets.search({ project?, q, status?, priority?, type?, epic?, include_done?, limit?, snippet_length? })`.
- Uses `bm25(tickets_fts, 3.0, 1.0)` — title weighted 3× over description.
- Snippet built via `snippet(tickets_fts, 3, '<mark>', '</mark>', '…', 16)`, default ~240 chars; `snippet_length` adjusts the token-count arg.
- Default `limit=10`, default `status IN ('open','in_progress','blocked')`, `include_done: false`.
- Returns ranked array of `{ id, title, status, priority, type, snippet, score }`.
- Tests cover: title-match outranks body-match, stemming finds "estimator" for query "estimators", multi-term AND semantics, filters layer on top of FTS, default status filter excludes archive.
**Acceptance:**
- Response token cost <1000 against seeded fixture.
- Search returns hits in <50ms p99 against a 1000-row fixture.

### T7 — Write tools and audit log
**Blockers:** T5.
**Scope:**
- `tickets.update({ project?, id, patch })` — patches any field on the ticket; each changed field appends to `audit_log` with `old_value`/`new_value`/`changed_at`.
- `tickets.append_to_description({ project?, id, text, separator? })` — appends `text` to existing description, default separator `"\n\n"`. Single audit entry per call.
- `tickets.link({ project?, from, to, kind, note? })` / `tickets.unlink({ project?, from, to, kind })` — manage typed relations. Validates both ids exist within the same project. `kind` validated against the known list (extensible via `force: true`).
- `tickets.set_parent({ project?, id, parent_id })` — set or clear `parent_id`. Cycle detection: rejects if it would create a cycle.
- `tickets.add_tag` / `tickets.remove_tag` — tag CRUD.
- Audit log entry on every write, including relation create/delete (`field='relation:<kind>'`, `new_value="<from>-><to>"`).
**Acceptance:**
- All tools callable, all writes audit-logged.
- Cycle detection on `set_parent` test-covered (A→B, B→A should reject).
- Tag normalisation: stored lowercase, trimmed.

### T8 — Convenience tools: next, related, blockers_of, children_of, changed_since, validate
**Blockers:** T5, T7.
**Scope:**
- `tickets.next({ project?, type? })` — returns the highest-priority unblocked open ticket. Unblocked = no `blocks` relations point at it from a non-`done`/`deferred` ticket. Ties broken by `id ASC`. Returns `{ ticket, reason }` where `reason` explains the choice (priority, age, no blockers).
- `tickets.related({ project?, id, kinds?, depth? })` — returns both incoming and outgoing relations grouped by direction and kind. Recurses up to `depth` (default 1, max 3).
- `tickets.blockers_of({ project?, id, depth? })` — convenience over `related` filtered to kind `blocks` outgoing direction.
- `tickets.children_of({ project?, id, depth? })` — descendants via `parent_id`, default depth 1.
- `tickets.changed_since({ project?, since, field?, new_value?, limit? })` — slices audit_log, `since` as ISO date. Returns compact rows.
- `tickets.validate({ project? })` — referential integrity report: orphan `parent_id`s, dangling relations (shouldn't happen with FKs, but check anyway), tickets with `closed_at` set but status not done/deferred, and vice versa.
**Acceptance:**
- `tickets.next` correctly skips blocked tickets and tickets whose blockers aren't yet done.
- Token budgets met: next <300, related <1000, blockers_of <1000, children_of <1500, changed_since <1000, validate <500.

## P2 — Migration and packaging

### T9 — Migration tool + demo parser
**Blockers:** T7.
**Scope:**
- `tickets.import_json({ project, file, dry_run? })` — generic ingester for the unified JSON intermediate format. On `dry_run`, returns counts + warnings without writing.
- JSON intermediate schema documented in `docs/import-format.md`.
- `src/parsers/demo.ts` — parses `~/Scripts/demo/.ai/TICKETS.md` into the JSON intermediate.
- Heuristics per design spec §7: parse `### T<n> — Title` headings, `**Status:**` blocks, `**Blockers:**` lists, narrative "Shipped (full list)" paragraph, follow-up/supersedes mentions in shipped notes.
- Two-pass parsing: tickets first, relations second (so cross-references resolve).
- CLI invocation: `node dist/parsers/demo.js <input.md> > tickets-import-demo.json` for the dry-run path.
**Acceptance:**
- Dry-run import on demo's real TICKETS.md produces a JSON intermediate that round-trips to ≥95% of the source tickets without manual fixup.
- Manual fixups (if any) documented in a `--report` flag output.
- Tests cover the 20 most-distinctive demo ticket shapes via fixture files.

### T10 — sample parser
**Blockers:** T9.
**Scope:**
- `src/parsers/sample.ts` — parses `~/sites/sample/.ai/TICKETS.md` to the same JSON intermediate.
- Heuristics: `### NAMESPACE-NN: Title — STATUS` headings, `## Epic N:` context, `> Output:` blockquotes, `**Blocked by:**` list, namespace prefix to `type` mapping (BUG→bug, FEAT→task, UX→task with tag, DESIGN→task with tag, SETUP→task).
- Dry-run round-trip test against the real sample file.
**Acceptance:**
- Dry-run produces ≥95% clean import for sample.
- Tests cover the 10 most-distinctive sample ticket shapes.

### T11 — Plugin manifest and install path
**Blockers:** T8.
**Scope:**
- `plugin.json` at repo root — Claude Code plugin manifest declaring the MCP server.
- Setup command equivalent to storybloq's `setup --client all`: registers the MCP with `claude mcp add ticketgraph` so the user doesn't run it manually. Implemented as `npm run setup` shipped in `package.json`.
- Document the dev-install path: `npm link` or `npm install -g .` from the repo, then `claude mcp add ticketgraph -- ticketgraph --mcp`.
- Document the future public-install path (npm + `claude plugin install` once published).
**Acceptance:**
- Fresh-machine setup walks user from `git clone` to working `tickets.ping` in <5 minutes.
- `claude mcp list` shows ticketgraph registered.

### T12 — README and usage docs
**Blockers:** T8.
**Scope:**
- `README.md` rewrite: problem, install, basic usage, tool reference summary, link to design spec.
- `docs/usage.md` — example prompts ("show me my open P0s", "what's blocking T7?", "find tickets about FTS") with the actual MCP calls Claude makes.
- `docs/import-format.md` — JSON intermediate schema for `import_json`.
- Migration guide for users coming from a flat TICKETS.md.
**Acceptance:**
- README answers: what is it, why is it different from storybloq, how do I install it, three example queries.
- A non-Ed reader could follow the README to a working install.

### T13 — CI via GitHub Actions
**Blockers:** T1.
**Scope:**
- `.github/workflows/ci.yml` — triggers on `push` to any branch and on `pull_request`. Single workflow, single job-matrix.
- Matrix: `{ node: '20.x', os: [ubuntu-latest, macos-latest] }`. macOS run is the §13 `better-sqlite3` native-build canary; do not drop it.
- Steps: `actions/checkout@v4`, `actions/setup-node@v4` with `cache: 'npm'`, `npm ci`, `npm run build`, `npm test`.
- Concurrency: `group: ci-${{ github.ref }}, cancel-in-progress: true` so force-pushes don't pile up.
- No coverage upload, no artifact upload, no release jobs. Keep the workflow under 40 lines.
- README install instructions get a CI badge once green.
**Acceptance:**
- A green run on `main` after this ticket lands; badge in README is green.
- A deliberately-broken test (introduced on a throwaway branch) produces a red run, with the failing test name visible in the GitHub UI without expanding any log group.
- macOS job completes in <2 minutes against the seeded fixture; if it doesn't, pin the `better-sqlite3` version (per §13 mitigation) before merging.
- Workflow file passes `actionlint` locally.

---

## v1.1 — Promoted from backlog

### T15 — Slash commands bundled with the plugin
**Status:** Open.
**Blockers:** none (the MCP tool surface T5–T8 is complete; slash commands are thin wrappers over it).
**Why:** the MCP tools are the canonical interface, but a few high-frequency actions are quicker as typed slash commands than as natural-language prompts. Bundling them with the plugin (they ship in `.claude-plugin/`, namespaced `/ticketgraph:<name>`) makes the common loop fast and discoverable.
**Scope:**
- Add a `commands/` (or `skills/`-style) directory referenced from `.claude-plugin/plugin.json` per the current Claude Code plugin slash-command convention (confirm the exact manifest field + file format against Claude Code docs before implementing — this is the main unknown).
- Ship the high-value commands the spec named, plus the obvious complements:
  - `/tickets-add <title>` → `tickets.add({ title })` (prompt for/accept optional priority, type, effort).
  - `/tickets-status` → `tickets.stats({})` for the current project (the "what's the state of this project" glance).
  - `/tickets-next` → `tickets.next({})` ("what should I work on?").
  - `/tickets-open` → `tickets.list({})` (outstanding work, default status filter).
  - `/tickets-done <id>` → `tickets.update({ id, patch: { status: "done" } })`.
- Each command is a thin instruction that calls the existing MCP tool — NO new server logic. Project scoping flows through the existing roots-based resolution (T14); commands never hardcode a project.
- Namespacing: commands surface as `/ticketgraph:tickets-add` etc. (plugin name prefix). Decide whether to keep the `tickets-` infix or rely on the namespace alone (`/ticketgraph:add`) — pick whichever reads better once the manifest format is confirmed.
- Document the commands in `docs/usage.md` (the prompt→call table already exists; add a "slash commands" subsection) and the README tool/usage section.
**Acceptance:**
- After `/reload-plugins` (or reinstall), the commands appear in Claude Code's slash-command list under the `ticketgraph` namespace.
- `/tickets-add "Test"` creates a ticket in the cwd-resolved project and reports the new id.
- `/tickets-status` returns the project's stats in <150 tokens (it's just `tickets.stats`).
- `/tickets-done <id>` flips the ticket to done (and `closed_at` is set via the existing trigger).
- No new server code paths — verified by `git diff` touching only `.claude-plugin/`, `commands/` (or equiv), and docs.
**Notes:**
- Effort: **3** (a normal day — the unknown is the plugin slash-command manifest format, not the logic; the tools already exist).
- Runs the four-stage dream-skills pipeline like every other ticket. The plan's first job is to pin down the current plugin slash-command file format (consult Claude Code docs / the `claude-code-guide`).

### T16 — Migration runner: detect & clearly report a version-ahead-of-schema DB
**Status:** Open. **Type:** bug (robustness/UX). **Effort:** 2.
**Found by:** a live migration session (2026-05-29) — `register_project` failed with a cryptic `no such table: projects` on a DB that had `user_version=1` but zero tables.
**Root cause:** during the T3→T4 dev window, `001_init.sql` shipped first as an empty placeholder that bumped `user_version` to 1, then was filled with the real schema in T4. Any `~/.claude/tickets.db` created in that window has `user_version=1` and no tables. The migration runner trusts `user_version` and applies only migrations with `N > current` — so it applies nothing, the schema never lands, and the failure surfaces much later as a cryptic SQLite error from the first tool that touches a table.
**Not recurring for fresh installs** (001 is now the full schema, so a new DB gets all tables at version 1) — but the runner has NO guard against a version/schema mismatch from ANY cause (interrupted migration, partially-applied future migration, a hand-edited DB). The cryptic-failure-much-later mode is the real defect.
**Scope:**
- After running migrations in `openDb()`, add a cheap startup integrity check: if `user_version >= 1` but a sentinel table (`projects`) is missing from `sqlite_master`, throw a clear, actionable `McpError`/Error naming the path and the likely cause, e.g.: `"Database at <path> reports schema version N but is missing expected tables (likely created by a pre-release build, or a migration was interrupted). Back it up and delete it, then restart to re-initialise."`.
- The check is O(1) (one `sqlite_master` lookup); run it only when `user_version >= 1`.
- Do NOT auto-delete or auto-repair the DB — surface the problem and let the operator decide (the DB may hold real data).
**Acceptance:**
- A DB fabricated with `PRAGMA user_version = 1` and no tables → `openDb()` throws the clear error (not a downstream `no such table`).
- A normally-migrated DB (`user_version=1`, tables present) → no error, opens fine.
- A fresh DB (`user_version=0`) → migrates to the full schema and passes the check.
- Unit tests for all three in `src/db.test.ts`; the existing migration tests stay green.
**Notes:** runs the four-stage pipeline. Captured in the migration-session memory anchor referenced by the feedback.

### T17 — demo parser fidelity enhancements
**Status:** Open. **Type:** enhancement (NOT a bug — current behaviour matches spec §7). **Effort:** 3.
**Found by:** the same live migration session. Each item below is *working as designed per spec §7*; this ticket is to improve migration fidelity if/when it matters, with `import_json({ force: true })` re-run after a fix.
**Scope (each item is opt-in; decide per item during planning):**
1. **Body-level priority override.** Priority/epic are derived from the `## P<n> — Name` section heading (spec §7). A ticket whose body says e.g. "Refactor P1" while sitting under `## P3 — Polish` (real example: T112) imports as P3. *Option:* when a body line carries an explicit `P<n>` priority marker, let it override the section default. *Risk:* prose false-positives — must be a precise pattern, not any "P1" substring.
2. **Type inference.** All demo tickets import as `type=task` (demo ids are bare `T<n>` with no type prefix, unlike sample). *Option:* infer `bug`/`spike` from title/heading keywords (e.g. "Spike:" → spike). *Risk:* keyword heuristics are noisy; keep conservative or skip.
3. **`closed_at` from narrative ship-notes.** Only inline Status-line dates are parsed; most done tickets get `closed_at=NULL` (spec §7 explicitly allows this). *Option:* also scan the "Shipped (full list)" narrative paragraph for per-ticket dates and back-fill `closed_at`.
4. **Prose-implied relations.** Only explicit patterns (`Blockers:`, `superseded by T<n>`, `Tracked as T<n>`) become relations; narrative-implied follow-ups (e.g. "T134 follows up T112" phrased loosely) aren't inferred. The plan deliberately chose conservative matching ("over-emitting noisy relations is worse than missing a few"). *Option:* add a small set of additional high-precision patterns; do NOT lower the precision bar.
**Acceptance:**
- For each item taken on: a fixture in `tests/fixtures/demo/` capturing the shape + a parser test asserting the improved output; the existing 22 fixtures stay green; the live-file calibration stays ≥95% headings parsed with NO increase in spurious relations.
- Items not taken on are explicitly recorded as won't-do with the reason.
**Notes:** runs the four-stage pipeline. Re-run migration with `force: true` after merging to refresh imported data.

### T18 — Orphaned MCP server processes accumulate (no stdin-close handler; `shutdown()` hangs)
**Status:** Open. **Type:** bug (resource leak / lifecycle). **Effort:** 2.
**Found by:** a live debugging session (2026-05-29) diagnosing `kernel_task` CPU saturation on Ed's M1 Pro. The machine was thrashing swap (50 GB swap 99.5% full, load avg ~520, 0% idle). Root cause was ~60 orphaned `node dist/server.js` processes (~180 MB each, ≈10 GB RAM), all reparented to launchd (`ppid 1`), accumulated over a 4-day uptime. `pkill` (SIGTERM) failed to reap them — only `kill -9` worked, which is itself a symptom (see defect #2).
**Root cause (two compounding defects):**
1. **No stdin-EOF shutdown.** The stdio server only handles `SIGTERM`/`SIGINT`. When the parent Claude Code session exits it closes the stdio pipes but does not reliably signal the child; with no `process.stdin` `end`/`close` handler the orphaned server runs forever and reparents to launchd. Every session that spawns the server and exits uncleanly leaks one process.
2. **`shutdown()` can hang, defeating SIGTERM.** `shutdown()` sets the `shuttingDown` guard, then `await server.close()`. For an orphan whose transport pipe is already dead, `server.close()` never resolves, so `process.exit(0)` is never reached — and the guard turns every subsequent SIGTERM into a no-op. The process is wedged half-shut and immune to normal kills.
- Compounded by the **global MCP registration** in `~/.claude.json` (every Claude session everywhere spawns one), so leaks accumulate fast across projects.
**Scope:**
- Add stdin lifecycle handling at startup in `src/server.ts`: exit on `process.stdin` `end`/`close` (parent pipe gone) and handle `SIGHUP`. A stdio MCP server with no live parent has no reason to keep running.
- Make `shutdown()` non-blocking-safe: arm an unref'd `setTimeout(() => process.exit(0), ~1000)` before `await server.close()`, so a hung close can never wedge the process. Keep `db.close()` / `server.close()` best-effort.
- Do **not** narrow the MCP registration scope — global is intentional; the fix is correct lifecycle, not narrower scope.
**Acceptance:**
- Spawn the built server, send `initialize`, then close its stdin → process exits within ~1 s (assert via the existing stdio harness).
- A server whose `server.close()` hangs still exits within the fallback window on SIGTERM (no wedged `shuttingDown` state).
- Normal `SIGTERM`/`SIGINT` path still runs `shutdown()` cleanly (db closed, audit intact) — existing graceful-shutdown tests stay green.
- Manual: opening then closing N Claude sessions leaves 0 residual `dist/server.js` processes (was: one leaked per session).
**Notes:** runs the four-stage pipeline. Localized to `src/server.ts` + tests — no new features. One-time operational cleanup of existing orphans is `pkill -9 -f 'ticketgraph/dist/server.js'` (plain SIGTERM is ineffective per defect #2).

### T19 — `tickets.add_many`: batch create over a shared `insertBatch` core
**Status:** Done (2026-05-29). **Type:** enhancement (token efficiency + ergonomics). **Effort:** 3.
**As-built:** `.ai/implementation-plans/2026-05-29-T19-add-many.md` (four-stage pipeline; 22 MCP tools; 486 tests green). `insertBatch` core extracted from `import_json`; `inferNextIds` batch auto-id; `tickets.add_many` returns a compact `{ created, count, warnings? }`.
**Found by:** a design discussion (2026-05-29). Tickets are often created in batches; today that's N separate `tickets.add` calls, and each one returns a **full 13-field ticket row** (`add.ts:241-245`) that mostly just echoes the inputs Claude already sent. `tickets.import_json` already does true bulk insert in one transaction and returns **compact counts, not rows** (`import_json.ts:346-354`) — but it only reads from a file on disk (`readFileSync`, `import_json.ts:97`), so it's the wrong tool for inline conversational batches.
**Decision (why a new tool, not a polymorphic `tickets.add`):** a single tool that accepts *either* a ticket *or* an array would return two different result shapes (`{ ticket }` vs `{ counts }`) and need a `oneOf` input schema — both are accuracy hazards for an LLM-operated tool, which selects reliably by tool *name* but handles result-shape branching and schema unions poorly. A "delegate the array to `import_json` behind the scenes" path also silently loses auto-id: `import_json` requires an explicit `id` on every ticket (`import-format.ts:70`), whereas `tickets.add` infers it (`inferNextId`, `add.ts:151-157`). So `tickets.add` stays untouched; a purpose-built `add_many` keeps auto-id and intra-batch references.
**Scope:**
- Extract the 3-pass insert from `import_json`'s transaction (`import_json.ts:197-319` — insert tickets → set `parent_id` → insert relations, with tags + `_created` audit) into a shared `insertBatch(db, projectId, tickets, relations)` helper in `src/lib/`. `import_json` becomes *read file → validate → `insertBatch`*; behaviour and existing tests unchanged.
- New tool `tickets.add_many({ project?, tickets: AddArgs[], relations? })` = *take inline array → validate → `insertBatch`*.
- **Auto-id within the batch:** when a ticket omits `id`, infer the project's next id once and increment sequentially across the batch (reuse `inferNextId`'s numbering scheme). Explicit ids and auto ids may mix in one call.
- **Intra-batch references:** a ticket's `parent_id` (or a relation endpoint) may point at a sibling created in the same call — the multi-pass `insertBatch` already resolves this. Document it.
- **Result shape:** compact — `{ created: string[], count, warnings? }`. Do **not** return full rows (that's the whole point). One id list, not N rows.
- **Atomicity:** all-or-nothing in one transaction (inherited from `insertBatch`) — one invalid ticket rolls the whole batch back. State this in the tool description so the model expects it (single-add lets partial progress survive; batch does not).
**Acceptance:**
- `tickets.add_many` with N inline tickets creates all N in one transaction and returns the compact id list (no full rows).
- Omitting `id` on every ticket assigns sequential ids in the project's scheme; mixing explicit + auto ids in one call works.
- A ticket whose `parent_id` references a sibling created in the same call resolves correctly (multi-pass).
- One invalid ticket → entire batch rolls back, clear `McpError` naming the offending ticket; DB unchanged.
- `import_json` still passes all existing tests after the `insertBatch` extraction (no behaviour change).
- Token check against the seeded fixture: an N-ticket `add_many` response is a compact id list, materially cheaper than N `tickets.add` responses.
**Notes:** runs the four-stage pipeline. Relates to T20 — `tickets.add`'s own full-row return is a T20 candidate. Effort **3**: the logic exists; the work is the clean `insertBatch` factoring + auto-id-across-batch + tests.

### T20 — Token-efficiency review of tool response shapes
**Status:** Open. **Type:** spike → enhancement (token efficiency). **Effort:** 3.
**Found by:** the same design discussion (2026-05-29). Question to answer: **is there scope to cut response token count without losing key data?** Several tools return more than the caller strictly needs — most clearly `tickets.add`, which returns the full 13-field row (`add.ts:241-245`) that largely echoes the inputs Claude just sent plus defaults; the only genuinely new datum is the assigned `id`.
**Scope (audit first, then targeted trims — do NOT trim blind):**
- Inventory every tool's response shape and classify each returned field as: (a) **new information** the caller didn't send (assigned id, computed counts, server defaults, relations, audit), (b) **echo** of caller input, or (c) **derivable/rarely-needed**.
- Known candidates to examine: `tickets.add` full-row return; `tickets.get` last-10 audit entries and full relation grouping; `tickets.list` summary field set; `tickets.update` return shape; the `warnings`/`counts` verbosity in import paths.
- **Preserve key data — prefer opt-in verbosity over deletion.** Where a field is sometimes needed, gate it behind a param (e.g. `fields?` / `verbose?` / `include_audit?`) rather than dropping it, so the lean shape is the default and full data is one flag away. Default shapes must still satisfy the existing per-tool token budgets in the design spec (§16 / the T5–T8 acceptance budgets) — this tightens them, never loosens.
- Produce a short findings doc (per-tool: current cost, proposed shape, tokens saved, risk) and land only the changes that are clear wins. Anything ambiguous is recorded as won't-do with the reason.
**Acceptance:**
- A findings doc in `.ai/` enumerating every tool's response classification and the recommended change (or explicit no-change) per tool.
- Each accepted change keeps all key data reachable (default-lean, opt-in-full) — no information becomes *unrecoverable* via the tool surface.
- Measured token deltas on the seeded fixture for each changed tool; existing token-budget acceptance tests stay green (and are tightened where a default got leaner).
- Existing behaviour/tests for unchanged tools stay green.
**Notes:** runs the four-stage pipeline. Relates to T19 (batch result shape) — `add_many` should land with the lean shape this review endorses. Effort **3**: the audit is bounded (~21 tools); implementation depends on findings and may be smaller.

### T21 — `tickets.export`: write a timestamp-stamped `.ai/TICKETS.md` snapshot
**Status:** Done (2026-05-30). **Type:** enhancement. **Effort:** 3.
**As-built:** `.ai/implementation-plans/2026-05-30-T21-export-markdown.md` (four-stage pipeline; 23 MCP tools; 506 tests green). Pure renderer `src/lib/export-markdown.ts` + DB collector `src/lib/export-collect.ts` + tool `src/tools/export.ts`; writes `<root>/.ai/TICKETS.md` with a generated-at banner, returns compact `{ path, bytes, ticket_count, exported_at }`. Spec non-goal reversed honestly (§3/§6/§11 dated annotations).
**Requested by:** Ed (2026-05-30) — "an export function which writes out a `.ai/TICKETS.md` dump, clearly labelled as an export at a specific time/date to avoid drift."
**Reverses a documented non-goal — call this out, don't paper over it.** The design spec deliberately ruled markdown export out: §"no markdown export pipeline" (Non-goals), §"The MCP is the canonical store. TICKETS.md files are not regenerated. They are migrated once at setup and then deleted.", and "Markdown export / TICKETS.md regeneration" sits in the deferred list. A `tickets.dump` is reserved only as a *"debug-only raw row export… token-heavy; not for normal queries."* This ticket consciously changes that stance for the human-readable snapshot case. The plan's **first job** is to record the spec amendment (update the Non-goals + the `tickets.dump` row, or add a "Reversed decisions" note) so the spec and behaviour don't disagree.
**Why now / the drift mitigation:** the DB is the canonical store, but a glanceable, diffable, git-committable markdown view of a project's tickets is genuinely useful (PR context, offline reading, history). The original objection was *drift* — a regenerated file silently diverging from the DB and being mistaken for the source of truth. The mitigation the request names is the whole point of this ticket: every export carries a loud, unmissable banner stating it is a generated point-in-time snapshot, when it was generated, and that the DB — not the file — is authoritative. Stale ≠ silently-stale.
**Fidelity caveat (state plainly in the plan and the tool description):** the export renders **only what the DB holds** — id, title, status, type, effort, priority/epic grouping, tags, blockers/relations, timestamps, and the `description` free-text blob verbatim. It does **not** reconstruct the rich hand-authored Scope/Acceptance/Notes structure of *this* very file unless that prose lives in `description`. So a regenerated `TICKETS.md` will look leaner than the current hand-maintained one. That is expected and is itself an argument for the banner.
**Design decisions to resolve in planning (recommendations noted):**
- **Tool name.** New `tickets.export` rather than overloading the reserved debug-only `tickets.dump` (different audience: human-readable snapshot vs raw row dump). Recommended: `tickets.export`.
- **Write-to-disk vs return-string.** The server is DB-only today; writing files is a new capability. Recommended: the tool *writes the file directly* (strongest drift defence — one call regenerates the banner'd file and the model can't forget the label), to `<project-root>/.ai/TICKETS.md` resolved via the existing roots-based resolution (T14), with an optional `path?` override. Returns a compact `{ path, bytes, ticket_count, exported_at }` — not the rendered body. Per the self-operated-tooling preference, fewer Claude-mediated steps = fewer ways to drift.
- **Scope of export.** Single resolved project (consistent with every other tool's project scoping). Optional status/priority filters are a nice-to-have, not required for v1.
**Scope:**
- New MCP tool `tickets.export({ project?, path? })`. Resolves project via roots (T14); default output path `<root>/.ai/TICKETS.md`.
- Render markdown: a generated-file banner (below), a live status table (Done / In progress / Open), then tickets grouped by priority/epic, each rendering its DB fields + `description` verbatim, with blockers/relations surfaced from the relations table.
- **Banner (mandatory, top of file):** an HTML comment `<!-- GENERATED BY ticketgraph — DO NOT EDIT BY HAND -->` plus a visible blockquote, e.g. `> **Exported 2026-05-30T14:22:03Z** from the ticketgraph DB (project \`ticketgraph\`, N tickets). The DB is the source of truth; this file is a point-in-time snapshot and *will* drift. Re-run \`tickets.export\` to refresh.` Timestamp is ISO-8601 UTC.
- Determinism: stable ticket ordering (by priority then id) so re-exports with no DB change produce a byte-identical body *except* the timestamp line — keeps git diffs to the banner when nothing else changed.
**Acceptance:**
- `tickets.export` on a seeded project writes `<root>/.ai/TICKETS.md` and returns `{ path, bytes, ticket_count, exported_at }`; the file opens with the `DO NOT EDIT` comment + the timestamped banner naming the project and count.
- The rendered body contains every ticket in the project, grouped by priority/epic, with status, type, effort, tags, and blockers/relations; `description` is reproduced verbatim.
- Re-exporting an unchanged DB changes only the timestamp line (deterministic body ordering) — assert via a diff that touches one line.
- `path?` override writes to the given path; project resolution still flows through roots/cwd (no hardcoded project).
- The spec is amended in the same PR (Non-goals + `tickets.dump` row updated, or a "Reversed decisions" note added) so spec and behaviour agree — verified by `git diff` touching `docs/specs/`.
- Existing tool tests stay green; new tests cover banner presence, field rendering, determinism, and path override.
**Notes:** runs the four-stage pipeline. Distinct from the P3 `tickets.dump` (raw debug JSON) and from the P3 "`tickets.dump` enhancements" bullet — this is the human-readable, drift-labelled markdown snapshot the spec previously declined. Effort **3**: rendering + grouping + first file-write capability + deterministic ordering + the spec amendment.

---

## CLI surface (v0.4 — runs either via MCP or CLI)

A second thin front-end over the existing `makeToolRegistry` so every tool is reachable as `ticketgraph <command> [--flags]` as well as over MCP. **Driver: token efficiency.** The MCP's cost is dominated not by per-call results (already <2k by design §3.1) but by the always-on schema tax — all 23 tool definitions injected into every connected session. The CLI removes that for sessions that don't touch tickets, and trims per-call output via a compact default format. Decisions locked with Ed 2026-05-31: dual-mode single bin · CLI default + MCP opt-in · compact-text default.

**Spec amendment is part of this epic (like T21).** §5 lists "No CLI" under YAGNI and §"Non-goals" repeats it; the P3 "CLI surface" bullet deferred it. T22's plan must first amend the spec (Non-goals + §5 + a "Reversed decisions" note) so spec and behaviour agree — verified by `git diff` touching `docs/specs/`.

**Design through-line — optimise for Claude's accuracy, not human ergonomics** (per Ed's standing preference): the CLI is operated mostly by Claude via Bash, so the command/flag surface mirrors the tool surface 1:1 with the *fewest mapping rules to remember*. CLI command = MCP tool name minus the `tickets.` prefix, **underscores preserved** (`ticketgraph add_many`, `ticketgraph register_project`, `ticketgraph set_parent`) — no `_`→`-` prettification that Claude would have to mentally transform. Flag names = `inputSchema` property names verbatim. One rule, no surprises.

### T22 — CLI entrypoint + schema-driven dispatch
**Status:** Done (2026-05-31). **Type:** feature (foundation for the CLI epic). **Effort:** 5. **As-built:** `.ai/implementation-plans/2026-05-31-T22-cli-entrypoint.md`.
**Blockers:** none (reuses the existing registry).
**Why effort 5:** the load-bearing ticket — mode detection, a generic schema-driven flag parser, the structured-input escape hatch, and the dispatch wiring all land here. T23–T25 are refinements on top.
**Scope:**
- **Dual-mode bin.** Keep the single `ticketgraph` bin (`dist/server.js`). Mode detection at startup: **no positional args, or `--mcp`** → current stdio MCP server (unchanged path). **First positional arg matches a known command** → CLI path. Anything else (unknown command) → CLI usage error on stderr, exit 2. Mode detection runs *before* the SDK import work, like the existing `--help` gate, so CLI invocations never pay the MCP import cost.
- **Command resolution.** Build the command set from `makeToolRegistry` by stripping the `tickets.` prefix from each tool name (underscores preserved). `ticketgraph list` → `tickets.list`, `ticketgraph add_many` → `tickets.add_many`. One registry, two front-ends.
- **Generic flag parser driven by `inputSchema`.** For the resolved tool, walk its `inputSchema.properties` to coerce `argv` into the raw object `parseArgs` expects: `--key value` for string/number; `--key` (presence = `true`) for boolean; repeated `--key v1 --key v2` for array-typed props; `--key all` etc. passed through as-is (the tool's own `parseArgs` validates). Unknown flags → usage error, exit 2. Reuse each tool's existing `parseArgs` for validation — **the CLI adds no second validation layer.**
- **Structured-input escape hatch.** Flat flags can't express the nested/array inputs of `add_many`, `import_json`, and bulk `link`. Support `--json '<json-string>'` **and** JSON on stdin (when stdin is not a TTY) — the parsed object is handed straight to `parseArgs`, bypassing flag parsing. Document which commands expect this.
- **Optional single positional for id-like commands** (nice-to-have, recommend including): `ticketgraph get T22` binds the lone positional to the tool's primary id param when the schema has an obvious one; otherwise everything is a flag. Keep the rule mechanical and documented.
- Dispatch: `parseArgs(raw) → handle(args) → print result` (formatting is T24; for T22 a JSON dump to stdout is the placeholder). DB opened in **write mode** for write commands, **read-only** for read commands (mirrors current behaviour; reuse `openDb`).
**Acceptance:**
- `ticketgraph` (no args) and `ticketgraph --mcp` still boot the stdio server; existing MCP integration tests stay green unchanged.
- `ticketgraph list --status open --limit 5` resolves to `tickets.list`, parses flags, calls `handle`, prints the result; matches the equivalent MCP call's data.
- `ticketgraph add_many --json '[…]'` and piping the same JSON via stdin both succeed and create the tickets; flag-only invocation of a structured command gives a clear "use --json/stdin" error.
- Unknown command and unknown flag each exit `2` with a stderr usage message; no stack trace leaks to stdout.
- Spec amended in the same PR (Non-goals + §5 + Reversed-decisions note); `git diff` touches `docs/specs/`.
- New tests: mode detection (server vs CLI vs unknown), flag coercion per JSON-schema type, the `--json`/stdin path, prefix-stripping command resolution. Existing suite stays green.
**Notes:** four-stage pipeline. The mode-detection gate must not regress the orphaned-process shutdown fixes from T18 — CLI invocations are short-lived and must exit cleanly without leaving the SIGKILL-timer / stdin-close machinery armed.

### T23 — CLI project resolution + error & exit-code mapping
**Status:** Done (2026-05-31). **Type:** feature. **Effort:** 3. **As-built:** `.ai/implementation-plans/2026-05-31-T23-cli-resolution-errors.md`.
**Blockers:** T22.
**Scope:**
- **Project resolution without MCP roots.** The CLI has no `listRoots()`; instead its `process.cwd()` *is* the user's real working dir (unlike the global MCP server, whose cwd is its spawn dir — the whole reason T14 exists). Provide a CLI `GetClientRoots` that returns `[]` so `requireProject` falls through to cwd, plus a git-root walk-up as a second candidate. Explicit `--project <id>` / `--project all` override exactly as in MCP. **No hardcoded project.**
- **Error mapping.** `McpError` (and any thrown error) from `parseArgs`/`requireProject`/`handle` must become a clean stderr line — *message only, no stack* — and a non-zero exit. Map: `InvalidParams` / `MethodNotFound` / unknown-command / bad-flags → exit `2` (usage/input); all other errors → exit `1`. Success → exit `0`. stdout carries results only; stderr carries diagnostics only (so `ticketgraph … | …` pipes stay clean).
- Logger currently writes to stderr at info level (stdout reserved for MCP protocol). For CLI, suppress info chatter by default (it would pollute stderr that a human reads); gate behind `TICKETGRAPH_DEBUG` / `--verbose`. Errors still surface.
**Acceptance:**
- Run from inside a registered project's dir (no `--project`) → resolves correctly via cwd; run from an unregistered dir → exit `2` with the "register one or pass --project" message; `--project all` on a read command works; `--project all` on a write-only command errors as in MCP.
- A validation failure (e.g. `update` with a bad status) prints one stderr line and exits `2`; nothing on stdout.
- `echo $?` reflects the documented 0/1/2 contract across success, validation error, and internal error.
- Info-level logs do not appear on a normal CLI run; `--verbose`/`TICKETGRAPH_DEBUG` re-enables them.
- New tests cover cwd resolution, the exit-code matrix, and stdout/stderr separation. Existing suite green.
**Notes:** four-stage pipeline. Effort 3: mostly reuses `requireProject`; the work is the resolver shim, the error→exit mapping, and log-routing.

### T24 — Output formatting (`--format compact|json|table`, compact default)
**Status:** Done (2026-05-31). **Type:** feature (the per-call token win). **Effort:** 3. **As-built:** `.ai/implementation-plans/2026-05-31-T24-output-formatting.md` (compact ~81% smaller than JSON on multi-row lists).
**Blockers:** T22.
**Scope:**
- A formatting layer applied to the plain data each tool's `handle` returns. `--format`:
  - **`compact` (default):** one line per row, space/tab-aligned, columns chosen per result shape (list/search/next → `id status priority type title`; get → a few key lines; stats → terse counts). No repeated JSON keys. This is the token-efficiency default for Claude callers.
  - **`json`:** the exact object today's MCP returns — for when Claude wants to parse, or for scripting. Stable, unformatted (single line) to stay diffable/greppable.
  - **`table`:** human-pretty aligned table (boxless), for Ed reading at a terminal.
- Format selection precedence: `--format` flag › `TICKETGRAPH_FORMAT` env › `compact`. Auto-detect is explicitly **not** done (no TTY-sniffing magic — predictable for Claude).
- The formatter is generic where possible (keys-as-columns) with small per-result-shape overrides only where compact output needs curation (list rows vs a single `get` vs `stats`). Resist a bespoke formatter per command — YAGNI.
**Acceptance:**
- `ticketgraph list` (compact) emits aligned rows with no JSON braces; `--format json` emits the same data as the MCP call; `--format table` emits an aligned human table.
- Measured: compact output for a seeded `list`/`search` is materially fewer tokens than the JSON shape (record the delta, mirroring T20's methodology).
- `TICKETGRAPH_FORMAT=json ticketgraph list` honours the env; explicit `--format` overrides it.
- New tests assert each format's shape for list/get/stats/next; existing suite green.
**Notes:** four-stage pipeline. Coordinate with T20 — the lean default response shapes T20 endorses are what `compact` renders; don't reintroduce trimmed fields here.

### T25 — Generated `--help` & discoverability
**Status:** Done (2026-05-31). **Type:** feature (keeps always-on cost to one line). **Effort:** 2. **As-built:** `.ai/implementation-plans/2026-05-31-T25-generated-help.md`.
**Blockers:** T22.
**Scope:**
- `ticketgraph --help` (no command) → top-level help: one line per command (name + the tool's `description`, truncated), plus the `--mcp` note and global flags (`--format`, `--project`, `--json`, `--verbose`). Rendered **from the registry** — never a hand-maintained list that can drift from the tools.
- `ticketgraph <command> --help` → per-command help generated from that tool's `inputSchema`: each property as a flag with its type, required/optional, and (where present) the schema's constraints; notes the `--json`/stdin path for structured commands.
- This is the discoverability mechanism that lets the always-on `CLAUDE.md` footprint stay at ~1 line: Claude learns commands on demand via `--help` instead of carrying 23 schemas every session.
- Reconcile with the **existing** `--help` behaviour in `server.ts` (currently prints the MCP one-liner): top-level `--help` now prints the CLI command index; preserve a path to the version/server blurb (e.g. `--version`).
**Acceptance:**
- `ticketgraph --help` lists every registry command with its description and exits `0`; adding a tool to the registry makes it appear with no help-text edit (assert by counting commands against the registry).
- `ticketgraph get --help` shows `--id`/positional and any flags derived from the schema; structured commands mention `--json`/stdin.
- `--version` reports the package version; `--help` no longer hides it.
- New tests render help from a stub registry and assert command/flag coverage. Existing suite green.
**Notes:** four-stage pipeline. Effort 2: pure rendering from existing metadata.

### T26 — Packaging, docs & MCP-becomes-opt-in
**Status:** Done (2026-05-31). **Type:** chore/docs (ships the epic). **Effort:** 3. **As-built:** `.ai/implementation-plans/2026-05-31-T26-packaging-mcp-optin.md` (v0.4.0; MCP now opt-in).
**Blockers:** T22, T23, T24, T25.
**Scope:**
- **Make MCP opt-in** so the token win is real (decision 2026-05-31): the plugin no longer auto-connects the MCP server by default. Update `.claude-plugin/plugin.json` / `.mcp.json` accordingly, and document how to turn the MCP back on for users who prefer it. (Confirm the exact mechanism during planning — plugin manifest vs user `claude mcp add`.)
- **Terse `CLAUDE.md` pointer** (the entire always-on cost): a single line telling Claude the project has token-cheap, DB-backed ticket queries via `ticketgraph <command>` and to run `ticketgraph --help` for the command list. **Do not** inline command docs — that would recreate the schema tax in another file.
- **Bash allowlist:** add `ticketgraph` read commands (`list`, `get`, `search`, `next`, `stats`, `changed_since`, `blockers_of`, `children_of`, `related`, `validate`) to project `.claude/settings.json` so routine queries don't prompt. Write commands stay prompt-gated.
- **Slash commands:** the bundled `commands/tickets-*.md` (T15) currently invoke MCP tools — repoint them at the CLI (or leave them MCP-driven and document both). Decide in planning; recommend CLI so they work with MCP off.
- **Docs:** `README.md` + `docs/usage.md` gain a CLI section (install, dual-mode, the format flags, the `--json`/stdin convention, exit codes). `docs/install.md` notes MCP is now opt-in.
- Version bump to **0.4.0**; CHANGELOG/commit notes the CLI surface and the MCP-default change (the latter is the one behaviour change existing users will notice).
**Acceptance:**
- Fresh install exposes `ticketgraph <command>` working with the MCP **not** auto-connected; re-enabling the MCP via the documented path restores tool access.
- `CLAUDE.md` pointer is ≤2 lines and contains no per-command schema; `--help` is the discovery path.
- Allowlisted read commands run without a permission prompt in a test session; write commands still prompt.
- Slash commands work in the default (MCP-off) configuration.
- README/usage/install updated; `npm run build` + full suite green; version is 0.4.0.
**Notes:** four-stage pipeline. This ticket is where "token efficiency is the driver" actually pays out — everything before it is plumbing; making MCP opt-in + a one-line pointer is what removes the always-on tax.

---

### T27 — Cut the token cost of the "outstanding tickets" read path
**Status:** Open. **Type:** enhancement (token efficiency / UX). **Effort:** 3.
**Found by:** a real session (2026-06-03) that spent ~3k tokens and **9 Bash calls** to answer "outstanding tickets" for a 4-ticket project. The model behaved correctly at each step; the surface defeated it. Same mission as T20/T22–T26 — token efficiency — but on the *read round-trip*, not the response shape. Note T20 deliberately did **not** touch the formatter or flag layer, so these failures are live in current code.

**The failure trace (verified against current code):**
1. `list --status open` → 1 ticket. `--status open` is narrower than the default filter (`open/in_progress/blocked`); "outstanding" has no alias, so the model guessed wrong first.
2. `get T143 T147 T86-followup` (default compact) → the **same truncated one-liner as `list`, no description**. Root cause: `cli/format.ts` `rowsOf()` wraps a single `{ticket}` as a row collection → `compactRows` renders only the 6 `TICKET_COLUMNS` (`format.ts:30-37`). `get`'s entire reason to exist (description, tags, relations) is invisible in the default format.
3. `--help` call just to find flags.
4. `get --id T143 --id T147 --id T86-followup --format json` → **only one ticket** (the last id). Root cause: `get` exposes a string `id` AND an array `ids` (`get.ts:65-66`); repeated `--id` hits the string branch which silently last-wins (`flags.ts:151-152`). The multi-fetch flag is the plural `--ids` (`flags.ts:139-142`), which nothing surfaces.
5. Fallback to N individual `get --format json` calls + a `stats` cross-check to discover a `deferred` ticket the default `list` hides.

**Scope (ranked by leverage — land the high-leverage ones, record any won't-do):**
- **(P1) `get` compact must render the full ticket body** — description + tags + relations, NOT the list row. `get` is the detail command; its compact output must differ from `list`'s. This one fix makes step 2 sufficient and removes the `--help` + JSON fallbacks. Likely a `get`-specific compact branch in `format.ts` (the formatter is generic/shape-driven today — add a single-full-ticket case, or special-case the `{ticket}`/`{tickets}` result of `get`).
- **(P1) Multi-id via CLI must never silently drop ids.** Pick one: make repeated `--id` collect into `ids`, accept `--ids a,b,c` (comma-split), or **throw** when `--id` appears >once pointing at `--ids`. Returning 1 of 3 silently is the footgun. Prefer: accept repeated `--id` as the array (most ergonomic for the model) OR a clear error.
- **(P2) Make the one-call path discoverable.** `list --include_description` already answers the whole question in ONE call for non-deferred tickets — it's just unknown. Document it in `skills/ticketgraph/SKILL.md` and top-level `--help`. Consider a `--status outstanding` alias (= the current default) and a help line stating `deferred`/`done` are excluded by default.
- **(P3) Compact title truncation** (60 chars, `format.ts:27`) forced an escalation just to read titles — widen it, or note `--format table` for multi-row reads. Lowest leverage; record as won't-do if the P1 items already remove the need.

**Acceptance:**
- `ticketgraph get <id>` in the DEFAULT (compact) format shows the description (and tags/relations), visibly distinct from `list`; a token-budget test guards the single-`get` compact size.
- Passing multiple ids via the CLI returns all of them (or fails loudly) — covered by a CLI spawn test; the silent-last-wins behaviour is gone.
- `SKILL.md` + `--help` document the one-call outstanding path; a test or doc-grep asserts the guidance exists.
- No regression to existing formats/tools; `npm run build` + full suite green.
- Findings note in `.ai/` measuring the before/after call-count + token cost of the "outstanding tickets" scenario on a seeded fixture (the 9-calls→target comparison).

**Notes:** four-stage pipeline. Relates to T20 (response shapes) and T24 (output formatting). The P1 pair (`get` body in compact + multi-id) is the bulk of the win; the rest is discoverability polish. Effort **3**: formatter change is localised, multi-id is a flag-layer tweak, docs are cheap.

---

### T28 — README CLI-first restructure + `ticketgraph mcp` command
**Status:** Open. **Type:** enhancement (docs + small CLI surface). **Effort:** 2.
**Found by:** user (2026-06-04). The README still front-loads the MCP server, but since v0.4.0 the **CLI is the default and the MCP is opt-in**. Two changes, one ticket: (1) a friendly `ticketgraph mcp` command to start the server, and (2) a CLI-first README.

**Part A — `ticketgraph mcp` command.**
Today the MCP stdio server boots on `argv.length === 0 || argv[0] === "--mcp"` (`server.ts:110`). Starting the server is a *mode*, not a registry tool, so the CLI catalogue (registry-derived in `buildCatalogue`) is the wrong layer — extend the entry-point switch instead.
- Add `argv[0] === "mcp"` as a third `serverMode` trigger (`server.ts:110`). Purely additive: bare-invocation and `--mcp` keep working so existing MCP client configs / `docs/install.md` registration stay valid.
- Make `mcp` discoverable: the top-level help footer (`commands.ts:65`, currently "Run with --mcp or no arguments to start the MCP server.") should present `ticketgraph mcp` as the preferred form, noting `--mcp`/no-args still work.
- **Don't** route `mcp` through `runCli`/`dispatch`/the catalogue — it has no tool, no `--format`, no flags; it hands off to `main()`. Keep it in the `server.ts` entry switch.
- **Don't** change the existing stdio launch contract (the comment at `server.ts:105-108` — MCP clients launch over stdio and that path must keep working).

**Part B — CLI-first README.**
Restructure so the CLI is the lede and MCP is a short optional section:
1. Title + token-economy problem (keep).
2. Quick start (CLI): install/build → `ticketgraph list` / `next` / `search` examples.
3. Token-efficiency USP.
4. Common commands table (read/write).
5. Using with Claude — the one-line `CLAUDE.md` pointer.
6. MCP server (optional) — brief: "ticketgraph also speaks MCP; start it with `ticketgraph mcp`. Opt-in — see docs/install.md."
7. Migration / Development / Licence (keep).
- Keep the accurate `As of v0.4.0…` historical phrasing; don't rewrite what shipped when. Update tool-count claims only if stale.

**Acceptance:**
- `ticketgraph mcp` starts the stdio MCP server (verified by a spawn test that the process boots and responds to an MCP `initialize`/`tools/list`, then shuts down on stdin close — mirror the existing spawn-test pattern); `--mcp` and no-args still start it (regression-tested).
- `ticketgraph --help` lists/points to `mcp` as the way to start the server.
- README leads with the CLI; the MCP appears only as a demoted optional section that references `ticketgraph mcp` and `docs/install.md`.
- `docs/install.md` "Enabling the MCP server" mentions `ticketgraph mcp` as the launch command (keeping the existing forms documented).
- `npm run build` + full suite green. Version bump (likely **0.6.0** — new CLI surface) with tag + GitHub release per `CLAUDE.md`.

**Notes:** four-stage pipeline. Part A is a ~1-line entry-switch change + help text + a spawn test; Part B is docs. Relates to T22–T26 (the dual-mode CLI this documents) and T25 (generated `--help`/discoverability). Effort **2**.

---

## P3 — Post-MVP polish (still deferred)

- **`tickets.dump` enhancements** — pagination, JSON-streaming for large projects.
- **Vector embedding sidecar** — opt-in `tickets_vec` table, local model via Ollama or hosted endpoint. Schema already reserves the name.
- **Audit log retention** — `tickets.audit.purge_before` once row counts justify it (10k+).
- ~~**CLI surface** — only if Ed wants out-of-Claude access. Currently no requirement.~~ **Reversed 2026-05-31 → now T22–T26 (CLI surface, v0.4).** Motivation turned out not to be out-of-Claude access but token efficiency: the CLI lets a session pay ~0 context until a ticket query is actually made, vs the MCP's always-on schema tax. See the CLI surface section above.
- **Cross-project relations** — link from demo's `T120` to sample's `FEAT-04`? Probably not, but the schema doesn't preclude it.

---

**Workflow note.** Every ticket runs the four-stage pipeline: `/writing-plans` → `/devils-advocate` → `/subagent-driven-development` → `/review-implementation`. Plans live at `.ai/implementation-plans/YYYY-MM-DD-<ticket-id>-<slug>.md`. No skipping steps.

**Self-hosting goal.** Once T9 lands, ticketgraph's own TICKETS.md becomes the first migration test — we eat our own dogfood before demo.
