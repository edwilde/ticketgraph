# ticketgraph — Design Spec

**Date:** 2026-05-28
**Author:** Ed Wilde (with Claude)
**Status:** Approved, ready for implementation planning
**Repository:** github.com/edwilde/ticketgraph (to be created)
**Working dir:** ~/Scripts/ticketgraph

---

## 1. Problem

Three of Ed's projects (sscloud, wesabe, nzta) track development work in dense `.ai/TICKETS.md` files. The largest (sscloud) is 4,127 lines / ~25,700 tokens. Every conversational query about tickets — "what's open?", "show me T123", "what changed today?" — forces Claude to read the entire file before it can answer.

The current cost per "outstanding tickets" question on sscloud is roughly one full TICKETS.md read every time the topic surfaces. That's a poor token economy for what is fundamentally a structured-data question.

## 2. Goal

Build a Claude Code plugin (`ticketgraph`) that backs ticket state with a structured store and exposes it via MCP, so every common ticket query has a token cost in the hundreds, not the tens-of-thousands.

The plugin is single-user, single-machine, and used exclusively by Ed in conjunction with Claude. There is no team-facing UI, no markdown export pipeline, and no plan for git-sync of ticket data.

## 3. Design principles

1. **Every common query response fits in <2k tokens by default.** This is an acceptance criterion, not a hope. `tickets.list`, `tickets.search`, `tickets.stats`, `tickets.changed_since`, `tickets.next` all have summary-by-default shapes. Full descriptions are returned only by `tickets.get` and only for the requested ticket(s).
2. **The MCP is the canonical store.** TICKETS.md files are not regenerated. They are migrated once at setup and then deleted.
3. **One global SQLite DB at `~/.claude/tickets.db`.** Cross-project queries are first-class. Project scoping is automatic from cwd; explicit `project: "<id>"` or `project: "all"` overrides.
4. **Resist tool sprawl.** Storybloq has 53 MCP tools; we ship with ~20. Every tool is a thing Claude must remember and Ed must maintain.
5. **YAGNI ruthlessly.** No CLI, no Mac app, no federation, no autonomous-mode state machine, no lessons/handovers/snapshots. Those concerns are handled by other tools Ed already uses (`/handoff`, auto-memory, `/writing-plans`, `/subagent-driven-development`).

## 4. Architecture

```
+-----------------------------------------------------------+
|  Claude Code session (any project, any cwd)               |
+-----------------------+-----------------------------------+
                        | MCP (stdio)
                        v
+-----------------------------------------------------------+
|  ticketgraph MCP server (single global instance)          |
|  - resolves project_id from cwd (git root) or explicit    |
|  - tools: list, get, search, next, stats, link, add, ...  |
+-----------------------+-----------------------------------+
                        |
                        v
+-----------------------------------------------------------+
|  ~/.claude/tickets.db   (SQLite, WAL mode)                |
|    projects, tickets, tickets_fts (FTS5),                 |
|    relations, tags, audit_log                             |
+-----------------------------------------------------------+
```

- **Language:** TypeScript on Node.js 20+.
- **Key dependencies:** `@modelcontextprotocol/sdk`, `better-sqlite3` (synchronous, FTS5 built in).
- **Transport:** stdio (standard MCP).
- **No filesystem watcher.** The server is the only writer; no external mutations to react to.
- **No external services.** No embedding model, no remote API, no telemetry.

### Why TypeScript

Anthropic's MCP SDK is most mature in TS. `better-sqlite3` ships with FTS5 enabled and is synchronous (correct fit for a single-process MCP server). Most existing Claude Code plugins are TS, so the plugin manifest and distribution path are well-trodden.

### Why a single global DB

Ed bounces between projects. A global DB lets `tickets.list({ project: "all", priority: "P0" })` work natively. SQLite's single-file model survives backup-by-`cp` trivially. The project_id discriminator on every row enforces logical separation without the operational cost of N separate files.

## 5. Schema

```sql
-- projects: one row per repo
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,        -- 'sscloud', 'wesabe', 'nzta'
  display_name  TEXT NOT NULL,
  root_path     TEXT NOT NULL UNIQUE,    -- absolute path used for cwd resolution
  created_at    TEXT NOT NULL            -- ISO 8601
);

-- tickets: the canonical table
CREATE TABLE tickets (
  id           TEXT NOT NULL,            -- 'T123', 'SETUP-01', 'BUG-04'
  project_id   TEXT NOT NULL REFERENCES projects(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL,            -- 'open' | 'in_progress' | 'blocked' | 'done' | 'deferred'
  priority     TEXT,                     -- 'P0' | 'P1' | 'P2' | 'P3' | NULL
  type         TEXT NOT NULL DEFAULT 'task', -- 'task' | 'bug' | 'spike' | 'followup' | 'umbrella'
  epic         TEXT,                     -- free-text grouping
  parent_id    TEXT,                     -- for umbrella/child hierarchy (sscloud T103 -> T112-T119)
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  closed_at    TEXT,                     -- set when status moves to done/deferred
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, parent_id) REFERENCES tickets(project_id, id) ON DELETE SET NULL
);

CREATE INDEX idx_tickets_status   ON tickets (project_id, status);
CREATE INDEX idx_tickets_priority ON tickets (project_id, priority);
CREATE INDEX idx_tickets_epic     ON tickets (project_id, epic);
CREATE INDEX idx_tickets_type     ON tickets (project_id, type);
CREATE INDEX idx_tickets_parent   ON tickets (project_id, parent_id);

-- relations: directed, typed edges between tickets
CREATE TABLE relations (
  project_id  TEXT NOT NULL,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL,            -- 'blocks' | 'follows_up' | 'supersedes' | 'relates_to'
  note        TEXT,                     -- optional one-line context
  created_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, from_id, to_id, kind),
  FOREIGN KEY (project_id, from_id) REFERENCES tickets(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, to_id)   REFERENCES tickets(project_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_relations_to   ON relations (project_id, to_id, kind);
CREATE INDEX idx_relations_from ON relations (project_id, from_id, kind);

-- tags: free-form labels
CREATE TABLE tags (
  project_id TEXT NOT NULL,
  ticket_id  TEXT NOT NULL,
  tag        TEXT NOT NULL,
  PRIMARY KEY (project_id, ticket_id, tag),
  FOREIGN KEY (project_id, ticket_id) REFERENCES tickets(project_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_tags_tag ON tags (tag);

-- FTS: title + description, porter stemming, title boosted 3x
CREATE VIRTUAL TABLE tickets_fts USING fts5(
  project_id UNINDEXED,
  ticket_id  UNINDEXED,
  title,
  description,
  tokenize = 'porter unicode61'
);

-- audit_log: every write, so "what changed today" is cheap
CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL,
  ticket_id    TEXT NOT NULL,
  field        TEXT NOT NULL,           -- 'status', 'description', 'created' (synthetic), ...
  old_value    TEXT,
  new_value    TEXT,
  changed_at   TEXT NOT NULL
);
CREATE INDEX idx_audit_changed_at ON audit_log (changed_at);
CREATE INDEX idx_audit_ticket     ON audit_log (project_id, ticket_id);
```

### Notes on schema choices

- **Composite primary key `(project_id, id)`** so `T1` can exist in multiple projects without collision.
- **Status is single source of truth.** No separate "shipped_at" column; `closed_at` covers it. The sscloud "Done / In progress / Open" table is `SELECT ... GROUP BY status`.
- **`type` is required and defaults to `task`.** Five values keep the discriminator small. `umbrella` is the special case for parent rows in T103→T112-T119 style hierarchies.
- **`parent_id` is hierarchical**, distinct from typed relations. A child ticket has exactly one parent; relations are many-to-many. This matches the storybloq umbrella concept.
- **All relations are directional** with no symmetric special-case. `tickets.related` returns both incoming and outgoing edges labelled, so callers never have to guess direction.
- **`tickets_vec` is intentionally reserved** as a name for a future embedding sidecar table. Schema is forward-compatible without rewrites.
- **Audit log is append-only.** Single writer, no GC for v1. At ~100 bytes per row and ~10 writes per day, the table will be <1 MB after a year.

## 6. MCP tool surface

Auto-scoped to current project from cwd; pass `project: "<id>"` to override, `project: "all"` for cross-project.

### Read tools (no side effects)

| Tool | Returns | Typical token cost |
|---|---|---|
| `tickets.list` | summary rows (id, title, status, priority, type, epic, parent_id) — *no descriptions* | 200-1500 |
| `tickets.get` | one or more full tickets with relations and last N audit entries | 500-5000 per ticket |
| `tickets.search` | up to N (default 10) FTS5-ranked hits with 240-char snippets | 200-1000 |
| `tickets.next` | the highest-priority unblocked open ticket (with reason) | 100-300 |
| `tickets.related` | both incoming and outgoing relations for a ticket, labelled by direction and kind | 100-1000 |
| `tickets.blockers_of` | dependency tree rooted at a ticket; convenience over `tickets.related` with kind=blocks | 100-1000 |
| `tickets.children_of` | direct children + grandchildren of an umbrella, by `parent_id` | 100-1500 |
| `tickets.changed_since` | audit-log slice for "what changed today/this week", with optional field/new_value filters | 100-1000 |
| `tickets.stats` | counts grouped by status/priority/epic/type for the active project | <100 |
| `tickets.validate` | referential integrity report: orphan parent_ids, dangling relations, status invariants | 50-500 |

### Default filters and budgets

- **`tickets.list` default status filter**: `status IN ('open', 'in_progress', 'blocked')` (excludes `done`/`deferred`). Pass `status: "all"` to override.
- **`tickets.search` default status filter**: same. The sscloud archive is huge and would otherwise dominate every search. Pass `include_done: true` to include shipped tickets.
- **`tickets.list` never returns descriptions** by default. Pass `include_description: true` to opt in (rare; usually `tickets.get` is the right tool).
- **FTS5 ranking**: `bm25(tickets_fts, 3.0, 1.0)` — title weighted 3x over description.
- **Default page size**: 50 for `tickets.list`, 10 for `tickets.search`. `limit` parameter overrides.

### Write tools

| Tool | What it does |
|---|---|
| `tickets.add` | Create a ticket. Auto-assigns next id in the project's numbering scheme unless `id` is provided. |
| `tickets.update` | Patch any field on a ticket. Each changed field appends to audit_log. |
| `tickets.append_to_description` | Append text to a ticket's description (for sscloud-style accreting ship-notes). |
| `tickets.link` | Create a relation `from -> to` with `kind` and optional `note`. |
| `tickets.unlink` | Remove a specific (from, to, kind) edge. |
| `tickets.set_parent` | Set or clear `parent_id` (umbrella hierarchy). |
| `tickets.add_tag` / `tickets.remove_tag` | Tag management. |

### Admin tools

| Tool | What it does |
|---|---|
| `tickets.register_project` | One-time registration: id, display_name, root_path. |
| `tickets.import_json` | Bulk import from the unified JSON intermediate format. Supports `dry_run: true`. |
| `tickets.dump` | Debug-only raw row export for a project. Token-heavy; not for normal queries. |

### Deliberate omissions

- **No `tickets.delete`.** Status `deferred` covers abandonment; deletes aren't reversible.
- **No bulk-update tool.** Iteration keeps the audit log per-ticket and avoids footguns.
- **No CLI, no daemon, no watcher, no Mac app.** YAGNI for single-user.
- **No embedding/vector tools.** Schema-reserved name only; can be added later without breaking the API.

## 7. Migration

Two projects to migrate: **sscloud** and **wesabe**. nzta is excluded (basically done; user explicitly said skip).

### Per-project parser

One small TypeScript parser per source format, writing to a unified JSON intermediate (`tickets-import-<project>.json`) that the generic `tickets.import_json` MCP tool ingests.

**sscloud parser:**
- `### T123 — Title` heading -> `id` + `title`
- `**Status:** ... ✅ Done` -> `status=done`, parse `closed_at` from inline dates
- `**Blockers:** T2, T5` -> relations of kind `blocks` (after all tickets exist, second pass)
- `**Scope:** ... **Acceptance:** ...` -> concatenated into `description`
- The "Shipped (full list)" paragraph is the canonical source for `status=done` + narrative ship-notes; these append to the per-ticket description
- T123 → T129 follow-up mentions in shipped notes -> relations of kind `follows_up`
- "T41 superseded by T70" -> relation of kind `supersedes`
- `P0`/`P1`/`P2`/`P3` from section headings -> `priority`
- Section names ("Foundation", "Auth + linking") -> `epic`

**wesabe parser:**
- `### NAMESPACE-NN: Title — STATUS` heading -> `id` + `title` + `status` (inline "DONE" or absent=open)
- `## Epic N: ...` heading context -> `epic`
- `> Output: ...` blockquotes -> appended to `description`
- `**Blocked by:**` -> relations of kind `blocks`
- The `BUG-/UX-/FEAT-/DESIGN-` prefix -> `type` mapping (BUG→`bug`, FEAT→`task`, etc.) and a tag

### Migration flow

1. Implement the MCP server + schema + core tools.
2. Write the sscloud parser, dry-run the import, eyeball the JSON intermediate.
3. `tickets.register_project({ id: "sscloud", root_path: "~/Scripts/sscloud" })`.
4. `tickets.import_json({ file: "...", dry_run: true })` -> review row counts, warnings.
5. `tickets.import_json({ file: "...", dry_run: false })`.
6. Delete `~/Scripts/sscloud/.ai/TICKETS.md`.
7. Repeat 2-6 for wesabe.
8. nzta: skip migration. Project can be registered later if it starts using the MCP.

### Open migration decisions (defaults committed)

- **Commit IDs (e.g. `commit 20d91af`) inside ticket bodies**: preserved verbatim in `description`, not parsed into a structured field.
- **Already-superseded tickets** (sscloud T41 "superseded by T70"): row is created with `status=done`, a `T70 supersedes T41` relation is added in the second pass.
- **Tickets with no acceptance criteria block**: `description` field is the concatenated scope + ship-notes; `acceptance_criteria` is not a separate column.

## 8. Search ranking and query semantics

Already covered inline above; summarized here for reference.

**FTS5 configuration:**
- `tokenize = 'porter unicode61'` — Porter stemming, Unicode-aware.
- `bm25(tickets_fts, 3.0, 1.0)` — title weighted 3x over description.
- Snippet: `snippet(tickets_fts, 3, '<mark>', '</mark>', '…', 16)` — 240 chars around match.
- No trigram/fuzzy tokenizer; size cost not worth it for a single-user CLI.

**Default sort orders:**
- `tickets.list` (open work): `priority ASC, id ASC`.
- `tickets.list` (shipped): `closed_at DESC, id ASC`.
- `tickets.search`: bm25 score, ties broken by `id ASC`.
- `tickets.changed_since`: `changed_at DESC`.

## 9. Plugin packaging

```
ticketgraph/
+-- plugin.json                # Claude Code plugin manifest
+-- mcp-server/
|   +-- package.json
|   +-- tsconfig.json
|   +-- src/
|   |   +-- server.ts          # MCP stdio entrypoint
|   |   +-- db.ts              # better-sqlite3 wrapper, migrations runner
|   |   +-- migrations/
|   |   |   +-- 001_init.sql
|   |   +-- tools/             # one file per tool
|   |   |   +-- list.ts
|   |   |   +-- get.ts
|   |   |   +-- search.ts
|   |   |   +-- next.ts
|   |   |   +-- ... etc
|   |   +-- parsers/
|   |       +-- sscloud.ts
|   |       +-- wesabe.ts
|   +-- tests/
+-- docs/
|   +-- specs/
|       +-- 2026-05-28-ticketgraph-design.md   # this file
+-- README.md
+-- LICENSE                    # MIT
```

**Distribution**: Claude Code plugin, eventually published to npm as `@edwilde/ticketgraph` (private or public — TBD). For v1 development, installed locally via the plugin system's dev path.

**Installation:**
1. `claude plugin install <repo-url>` (or local dev install).
2. First server start: creates `~/.claude/tickets.db`, applies `001_init.sql`, records `PRAGMA user_version`.
3. `tickets.register_project` per project, then migration.

**Configuration:**
- No required config.
- Optional env var `TICKETGRAPH_DB_PATH` to override the default db location (testing).
- Schema migrations apply on startup; tracked via `PRAGMA user_version`.

## 10. Performance budgets (acceptance criteria)

These are first-class success criteria, not aspirations.

| Operation | Budget | Rationale |
|---|---|---|
| `tickets.list` default (open work) | <1500 tokens | Summary rows only |
| `tickets.search` default | <1000 tokens | 10 hits × 240-char snippet + meta |
| `tickets.stats` | <100 tokens | Just counts |
| `tickets.get` single ticket | <2000 tokens typical, <5000 hard cap | Full description varies wildly |
| `tickets.next` | <300 tokens | Single ticket summary + reason |
| `tickets.changed_since` (24h) | <1000 tokens | Compact audit slice |
| Server cold-start to first response | <500ms | Includes DB open + migration check |
| SQLite query latency (any read tool) | <50ms p99 | Indexes cover all common predicates |

Token costs measured against a populated sscloud import (~130 tickets, ~30 relations).

## 11. Out of scope for v1

Listed explicitly so they don't creep in:
- Markdown export / TICKETS.md regeneration.
- CLI surface.
- Vector / semantic search (schema name reserved).
- Multi-machine sync.
- Teammate-facing read access.
- Mac app or any GUI.
- Federation across repos (the global DB makes this trivial when needed).
- Autonomous-mode state machine.
- Lessons / handovers / snapshots (other tools cover these).
- Slash commands like `/tickets-add` (post-v1 polish once MCP API stabilises).

## 12. Differentiation vs storybloq

Storybloq exists and solves an overlapping problem. Ticketgraph stays distinct because:

1. **Token efficiency is the explicit USP.** Every common query <2k tokens. Storybloq's per-file JSON model reads N files per list query; ticketgraph's SQLite + FTS5 reads summaries only.
2. **Permissive license** (MIT planned) vs storybloq's PolyForm-NC.
3. **Typed directional relations** (`blocks`, `follows_up`, `supersedes`, `relates_to` with notes) vs storybloq's single-kind `blockedBy`.
4. **Tight scope.** No autonomous mode, no lessons, no handovers, no federation — Ed already has tools for those.
5. **No team-facing surfaces.** Single-user single-machine by design.

Wins borrowed from storybloq: the `type` field, `parent_id` umbrella hierarchy, `next` recommendation tool, `validate` integrity tool.

## 13. Risks and known unknowns

| Risk | Mitigation |
|---|---|
| Migration parsers miss edge cases in dense sscloud narrative | Dry-run + JSON eyeball before live import; manual fixups via `tickets.update` after |
| FTS5 ranking poor on symbol-heavy ticket bodies | Porter stemming is well-tested; if relevance is weak, switch to `unicode61` only + custom prefix queries. Listed as a v1.1 follow-up if needed. |
| Global DB grows large, sqlite vacuum needed | Negligible at ~500 tickets and ~5000 audit rows. Re-evaluate at 10k+. |
| `better-sqlite3` native build breaks on macOS upgrade | Pin to a known-good version; CI smoke test on macOS runner. |
| Project_id collision when registering | UNIQUE on `root_path` and PRIMARY KEY on `id`; `register_project` rejects duplicates with a clear error. |
| Audit log unbounded growth | Single user, ~10 writes/day -> negligible. Add `audit.purge_before` tool only if it becomes a real problem. |

## 14. Implementation order (suggested for writing-plans)

1. Scaffold TypeScript project, MCP stdio server skeleton, better-sqlite3 wiring.
2. Migrations runner + `001_init.sql`.
3. Core read tools: `register_project`, `add` (manual), `list`, `get`, `stats`. Smoke-test by hand.
4. Search: `tickets_fts` triggers (keep FTS in sync with tickets table), `search`.
5. Writes: `update`, `append_to_description`, `link`/`unlink`, `set_parent`, tags. Audit log writes.
6. Convenience tools: `next`, `related`, `blockers_of`, `children_of`, `changed_since`, `validate`.
7. Migration: `import_json` tool + sscloud parser. Dry-run, eyeball, live import.
8. Migration: wesabe parser. Same loop.
9. Plugin manifest + install path.
10. README + minimal usage docs.

---

End of spec.
