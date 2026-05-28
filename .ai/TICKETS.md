# ticketgraph — Development Tickets

Each ticket is self-contained. Build with `/writing-plans` → `/subagent-driven-development` → `/review-implementation`. TDD throughout — testing contract is **§16 of the design spec** (three layers, version-controlled fixtures, every Acceptance bullet maps to a named test).

**Priority levels:** P0 must ship before anything else; P1 is v1 MVP; P2 is v1 polish; P3 is v1.1+.
**Read first:** `docs/specs/2026-05-28-ticketgraph-design.md`.

## Ticket status (live)

| Done ✅ | In progress | Open |
|---|---|---|
| T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14 | _(none)_ | T15 |

**All tickets complete (2026-05-29).** 410 tests across 42 files, deterministically green (verified 12/12 consecutive full-suite runs). 21 MCP tools, sscloud + wesabe parsers (both 100% heading parse on the live files), plugin manifest + install docs, README + usage + migration docs, and GitHub Actions CI (ubuntu + macOS).

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

### T9 — Migration tool + sscloud parser
**Blockers:** T7.
**Scope:**
- `tickets.import_json({ project, file, dry_run? })` — generic ingester for the unified JSON intermediate format. On `dry_run`, returns counts + warnings without writing.
- JSON intermediate schema documented in `docs/import-format.md`.
- `src/parsers/sscloud.ts` — parses `~/Scripts/sscloud/.ai/TICKETS.md` into the JSON intermediate.
- Heuristics per design spec §7: parse `### T<n> — Title` headings, `**Status:**` blocks, `**Blockers:**` lists, narrative "Shipped (full list)" paragraph, follow-up/supersedes mentions in shipped notes.
- Two-pass parsing: tickets first, relations second (so cross-references resolve).
- CLI invocation: `node dist/parsers/sscloud.js <input.md> > tickets-import-sscloud.json` for the dry-run path.
**Acceptance:**
- Dry-run import on sscloud's real TICKETS.md produces a JSON intermediate that round-trips to ≥95% of the source tickets without manual fixup.
- Manual fixups (if any) documented in a `--report` flag output.
- Tests cover the 20 most-distinctive sscloud ticket shapes via fixture files.

### T10 — wesabe parser
**Blockers:** T9.
**Scope:**
- `src/parsers/wesabe.ts` — parses `~/sites/wesabe/.ai/TICKETS.md` to the same JSON intermediate.
- Heuristics: `### NAMESPACE-NN: Title — STATUS` headings, `## Epic N:` context, `> Output:` blockquotes, `**Blocked by:**` list, namespace prefix to `type` mapping (BUG→bug, FEAT→task, UX→task with tag, DESIGN→task with tag, SETUP→task).
- Dry-run round-trip test against the real wesabe file.
**Acceptance:**
- Dry-run produces ≥95% clean import for wesabe.
- Tests cover the 10 most-distinctive wesabe ticket shapes.

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

---

## P3 — Post-MVP polish (still deferred)

- **`tickets.dump` enhancements** — pagination, JSON-streaming for large projects.
- **Vector embedding sidecar** — opt-in `tickets_vec` table, local model via Ollama or hosted endpoint. Schema already reserves the name.
- **Audit log retention** — `tickets.audit.purge_before` once row counts justify it (10k+).
- **CLI surface** — only if Ed wants out-of-Claude access. Currently no requirement.
- **Cross-project relations** — link from sscloud's `T120` to wesabe's `FEAT-04`? Probably not, but the schema doesn't preclude it.

---

**Workflow note.** Every ticket runs the four-stage pipeline: `/writing-plans` → `/devils-advocate` → `/subagent-driven-development` → `/review-implementation`. Plans live at `.ai/implementation-plans/YYYY-MM-DD-<ticket-id>-<slug>.md`. No skipping steps.

**Self-hosting goal.** Once T9 lands, ticketgraph's own TICKETS.md becomes the first migration test — we eat our own dogfood before sscloud.
