# ticketgraph — Design Spec

**Date:** 2026-05-28
**Author:** Ed Wilde (with Claude)
**Status:** Approved, ready for implementation planning
**Repository:** github.com/edwilde/ticketgraph (to be created)
**Working dir:** ~/Scripts/ticketgraph

---

## 1. Problem

Three of Ed's projects (demo, sample, acme) track development work in dense `.ai/TICKETS.md` files. The largest (demo) is 4,127 lines / ~25,700 tokens. Every conversational query about tickets — "what's open?", "show me T123", "what changed today?" — forces Claude to read the entire file before it can answer.

The current cost per "outstanding tickets" question on demo is roughly one full TICKETS.md read every time the topic surfaces. That's a poor token economy for what is fundamentally a structured-data question.

## 2. Goal

Build a Claude Code plugin (`ticketgraph`) that backs ticket state with a structured store and exposes it via MCP, so every common ticket query has a token cost in the hundreds, not the tens-of-thousands.

The plugin is single-user, single-machine, and used exclusively by Ed in conjunction with Claude. There is no team-facing UI, no markdown export pipeline, and no plan for git-sync of ticket data.

## 3. Design principles

1. **Every common query response fits in <2k tokens by default.** This is an acceptance criterion, not a hope. `tickets.list`, `tickets.search`, `tickets.stats`, `tickets.changed_since`, `tickets.next` all have summary-by-default shapes. Full descriptions are returned only by `tickets.get` and only for the requested ticket(s).
2. **The MCP is the canonical store.** TICKETS.md files are not regenerated. They are migrated once at setup and then deleted. *→ Superseded 2026-05-30 (T21): regeneration is now supported via `tickets.export`, which writes a `.ai/TICKETS.md` snapshot carrying a loud generated-at banner. The DB remains the canonical store; the exported file is an explicitly drift-labelled, point-in-time view, never a source of truth.*
3. **One global SQLite DB at `~/.claude/tickets.db`.** Cross-project queries are first-class. Project scoping is automatic from cwd; explicit `project: "<id>"` or `project: "all"` overrides.
4. **Resist tool sprawl.** Storybloq has 53 MCP tools; we ship with ~20. Every tool is a thing Claude must remember and Ed must maintain.
5. **YAGNI ruthlessly.** No CLI, no Mac app, no federation, no autonomous-mode state machine, no lessons/handovers/snapshots. Those concerns are handled by other tools Ed already uses (`/handoff`, auto-memory, `/writing-plans`, `/subagent-driven-development`). *→ "No CLI" superseded 2026-05-31 (T22–T26): a dual-mode CLI is now in scope, driven by token efficiency — the MCP injects all ~23 tool schemas into every connected session (~2–4k tokens of always-on context tax), whereas `ticketgraph <command>` invoked via Bash costs ~0 context until used. The CLI becomes the default and the MCP becomes opt-in (T26). The other YAGNI omissions stand.*

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

### Project resolution from cwd

When a tool is called without an explicit `project` parameter, the server resolves the active project by:

1. Reading `process.cwd()` and canonicalising it (`fs.realpathSync` — follow symlinks).
2. Selecting the project whose `root_path` is the longest matching prefix of cwd. Equality counts as a match; nested checkouts therefore resolve to the parent project correctly.
3. If no `root_path` is a prefix of cwd, returning a structured error pointing at `tickets.register_project`. Tools never silently fall back to a different project.

Explicit `project: "<id>"` always overrides cwd resolution. `project: "all"` is the reserved cross-project scope on read tools (see §5).

## 5. Schema

```sql
-- projects: one row per repo
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,        -- 'demo', 'sample', 'acme'
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
  effort       INTEGER CHECK (effort IS NULL OR effort IN (1, 2, 3, 5, 8, 13)), -- Fibonacci story points
  epic         TEXT,                     -- free-text grouping
  parent_id    TEXT,                     -- for umbrella/child hierarchy (demo T103 -> T112-T119)
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

-- FTS5 synchronisation: keep tickets_fts in lockstep with tickets
CREATE TRIGGER tickets_fts_ai AFTER INSERT ON tickets BEGIN
  INSERT INTO tickets_fts (project_id, ticket_id, title, description)
  VALUES (new.project_id, new.id, new.title, new.description);
END;
CREATE TRIGGER tickets_fts_ad AFTER DELETE ON tickets BEGIN
  DELETE FROM tickets_fts WHERE project_id = old.project_id AND ticket_id = old.id;
END;
CREATE TRIGGER tickets_fts_au AFTER UPDATE OF title, description ON tickets BEGIN
  UPDATE tickets_fts
    SET title = new.title, description = new.description
    WHERE project_id = new.project_id AND ticket_id = new.id;
END;

-- closed_at maintenance: set on transition into done/deferred, clear on return to non-terminal.
-- Application code (not a trigger) writes the audit_log row so the operator id is preserved.
CREATE TRIGGER tickets_closed_at_set AFTER UPDATE OF status ON tickets
WHEN new.status IN ('done', 'deferred') AND old.status NOT IN ('done', 'deferred') BEGIN
  UPDATE tickets
    SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE project_id = new.project_id AND id = new.id AND closed_at IS NULL;
END;
CREATE TRIGGER tickets_closed_at_clear AFTER UPDATE OF status ON tickets
WHEN new.status NOT IN ('done', 'deferred') AND old.status IN ('done', 'deferred') BEGIN
  UPDATE tickets SET closed_at = NULL
    WHERE project_id = new.project_id AND id = new.id;
END;
```

### Notes on schema choices

- **Composite primary key `(project_id, id)`** so `T1` can exist in multiple projects without collision.
- **Status is single source of truth.** No separate "shipped_at" column; `closed_at` covers it. The demo "Done / In progress / Open" table is `SELECT ... GROUP BY status`.
- **`type` is required and defaults to `task`.** Five values keep the discriminator small. `umbrella` is the special case for parent rows in T103→T112-T119 style hierarchies.
- **`effort` is Fibonacci story points (1, 2, 3, 5, 8, 13), nullable.** The `CHECK` constraint forces the canonical scale — no 4s, no 7s, no false precision. NULL means "not sized yet". Assignment guide lives in §15. Chosen over t-shirt sizes because the numeric scale sums into `tickets.stats` and the gaps map to Claude's actual estimation uncertainty.
- **`parent_id` is hierarchical**, distinct from typed relations. A child ticket has exactly one parent; relations are many-to-many. This matches the storybloq umbrella concept.
- **All relations are directional** with no symmetric special-case. `tickets.related` returns both incoming and outgoing edges labelled, so callers never have to guess direction.
- **`tickets_vec` is intentionally reserved** as a name for a future embedding sidecar table. Schema is forward-compatible without rewrites.
- **Audit log is append-only.** Single writer, no GC for v1. At ~100 bytes per row and ~10 writes per day, the table will be <1 MB after a year.
- **`audit_log` has no foreign key to `tickets`.** Deliberately decoupled so the log survives any future hard-delete tool and so re-imports don't cascade-delete history. The `(project_id, ticket_id)` index is the join path.
- **Timestamps are UTC ISO 8601 with millisecond precision** (`YYYY-MM-DDTHH:MM:SS.sssZ`). Server-set on every write; clients never pass `created_at`/`changed_at`/`closed_at` directly. The SQLite expression `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` is the canonical generator.
- **Relation direction is canonical.** The `from` ticket is always the active party:
  - `from blocks to` → `from` is the blocker; `to` is waiting on `from`. `tickets.blockers_of(X)` therefore looks for rows with `to = X`.
  - `from follows_up to` → `from` is the follow-up; `to` is the predecessor.
  - `from supersedes to` → `from` is the replacement; `to` is the retired ticket (typically `status = done` with a `closed_at` reflecting the supersession).
  - `from relates_to to` is the only symmetric kind; either direction is valid and `tickets.related` will still surface it from both ends.
  `tickets.related` always labels edges by direction (`incoming`/`outgoing`) and kind so callers never have to remember the convention.
- **`kind` is validated in server code, not via a DB `CHECK` constraint.** Known kinds: `blocks`, `follows_up`, `supersedes`, `relates_to`. Keeping enforcement in code lets `tickets.link({ force: true })` admit a future kind without a schema migration; the canonical answer is still the set above.
- **Reserved project ids.** `"all"` is reserved as the cross-project scope on read tools and may not be registered. `tickets.register_project({ id: "all" })` rejects with a clear error. `"current"` is similarly reserved against future use.
- **Tag normalisation.** Tags are stored lowercase-trimmed (`tag.trim().toLowerCase()`). `tickets.add_tag({ tag: "  FTS  " })` stores `fts`. Comparisons are exact-match on the normalised form.
- **Audit log row shapes** (one row per atomic change; the writer is responsible for the row — no audit triggers, so application-level transactions wrap the write + audit pair):
  - Ticket creation: `field='_created'`, `old_value=NULL`, `new_value=<id>`.
  - Field change: `field=<column-name>`, `old_value=<prior-value-or-NULL>`, `new_value=<new-value-or-NULL>`.
  - `description` overwrite (`tickets.update`): `field='description'`, full new description in `new_value` (accept the bloat; rare relative to appends).
  - `description` append (`tickets.append_to_description`): `field='description:append'`, the appended text only in `new_value`. Cheaper to scan in `changed_since`.
  - Relation add: `field='relation:<kind>'`, `old_value=NULL`, `new_value='<from>-><to>'`.
  - Relation remove: `field='relation:<kind>'`, `old_value='<from>-><to>'`, `new_value=NULL`.
  - Tag add: `field='tag'`, `old_value=NULL`, `new_value=<tag>`.
  - Tag remove: `field='tag'`, `old_value=<tag>`, `new_value=NULL`.
  - `parent_id` change: `field='parent_id'`, `old_value=<old-parent-or-NULL>`, `new_value=<new-parent-or-NULL>`.
- **Effort sums in `tickets.stats` exclude umbrellas naturally.** §15 rule 6 sets umbrella `effort` to NULL; `SUM(effort)` skips NULLs, so umbrella points are never double-counted alongside their children.

## 6. MCP tool surface

Auto-scoped to current project from cwd; pass `project: "<id>"` to override, `project: "all"` for cross-project.

### Read tools (no side effects)

| Tool | Returns | Typical token cost |
|---|---|---|
| `tickets.list` | summary rows (id, title, status, priority, type, effort, epic, parent_id) — *no descriptions* | 200-1500 |
| `tickets.get` | one or more full tickets with relations and last N audit entries. `ids` array capped at 10 per call to bound response size. | 500-5000 per ticket |
| `tickets.search` | up to N (default 10) FTS5-ranked hits with 240-char snippets | 200-1000 |
| `tickets.next` | the highest-priority `status='open'`, unblocked ticket (no incoming `blocks` edges from a non-`done`/`deferred` ticket). Returns `{ ticket, reason: { priority, age_days, no_open_blockers: true } }`. Sort: `priority ASC NULLS LAST, created_at ASC`. | 100-300 |
| `tickets.related` | incoming and outgoing relations for a ticket, labelled by direction and kind. Recurses up to `depth` (default 1, max 3). | 100-1000 |
| `tickets.blockers_of` | tickets that block this one — incoming `blocks` edges, recursed up to `depth` (default 2, max 3) to surface the full dependency tree rooted at the ticket. | 100-1000 |
| `tickets.children_of` | descendants of an umbrella via `parent_id`, recursed up to `depth` (default 2, max 3). | 100-1500 |
| `tickets.changed_since` | audit-log slice for "what changed today/this week", with optional field/new_value filters | 100-1000 |
| `tickets.stats` | counts grouped by status/priority/epic/type, plus point totals grouped by effort and by epic, for the active project. Supports `project: "all"` for cross-project aggregates. | <150 |
| `tickets.validate` | referential integrity report: orphan parent_ids, dangling relations, status invariants | 50-500 |

### Default filters and budgets

- **`tickets.list` default status filter**: `status IN ('open', 'in_progress', 'blocked')` (excludes `done`/`deferred`). Pass `status: "all"` to override.
- **`tickets.search` default status filter**: same. The demo archive is huge and would otherwise dominate every search. Pass `include_done: true` to include shipped tickets.
- **`tickets.list` never returns descriptions** by default. Pass `include_description: true` to opt in (rare; usually `tickets.get` is the right tool).
- **FTS5 ranking**: `bm25(tickets_fts, 3.0, 1.0)` — title weighted 3x over description.
- **Default page size**: 50 for `tickets.list`, 10 for `tickets.search`. `limit` parameter overrides.

### Write tools

| Tool | What it does |
|---|---|
| `tickets.add` | Create a ticket. If `id` is supplied it is used verbatim (must be unique within the project). If omitted, the server inspects the project's existing ids: when a single prefix dominates (e.g. all `T<n>`), it uses that prefix with `max(n)+1`; when multiple prefixes co-exist (e.g. sample's `BUG-`/`FEAT-`/`UX-`/`DESIGN-`/`SETUP-`), `tickets.add` errors and forces the caller to pass `id` explicitly. Fallback for an empty project: `T1`. Writes a `_created` audit row. |
| `tickets.update` | Patch any field on a ticket. Each changed field appends to audit_log. |
| `tickets.append_to_description` | Append text to a ticket's description (for demo-style accreting ship-notes). |
| `tickets.link` | Create a relation `from -> to` with `kind` and optional `note`. |
| `tickets.unlink` | Remove a specific (from, to, kind) edge. |
| `tickets.set_parent` | Set or clear `parent_id` (umbrella hierarchy). |
| `tickets.add_tag` / `tickets.remove_tag` | Tag management. |

### Admin tools

| Tool | What it does |
|---|---|
| `tickets.ping` | Liveness check. Returns `{ ok: true, version, db_path, schema_version }`. Used by setup scripts, the vitest stdio harness, and "is this thing on?" prompts. No side effects. |
| `tickets.register_project` | One-time registration: id, display_name, root_path. Rejects reserved ids (`all`, `current`) and duplicate `root_path`. |
| `tickets.update_project` | Update a registered project's `display_name` or `root_path` (e.g. when a repo moves). `id` is immutable. |
| `tickets.import_json` | Bulk import from the unified JSON intermediate format (see §7). Supports `dry_run: true`. Refuses to overwrite existing `(project_id, id)` rows unless `force: true`. |
| `tickets.dump` | Debug-only raw row export for a project. Token-heavy; not for normal queries. |
| `tickets.export` | (T21) Render the project's tickets to a human-readable, drift-labelled markdown snapshot (default `<root>/.ai/TICKETS.md`), with a generated-at banner naming the DB as the source of truth. **Overwrites** the target. Distinct from the debug-only `tickets.dump`. |

### Deliberate omissions

- **No `tickets.delete`.** Status `deferred` covers abandonment; deletes aren't reversible.
- **No bulk-update tool.** Iteration keeps the audit log per-ticket and avoids footguns.
- **No CLI, no daemon, no watcher, no Mac app.** YAGNI for single-user. *→ "No CLI" reversed 2026-05-31 (T22–T26): a dual-mode `ticketgraph <command>` CLI shares the same tool registry as the MCP (see §3 principle 5 and §11). No daemon/watcher/Mac app — those stand.*
- **No embedding/vector tools.** Schema-reserved name only; can be added later without breaking the API.

## 7. Migration

Two projects to migrate: **demo** and **sample**. acme is excluded (basically done; user explicitly said skip).

### Unified JSON intermediate

Each parser writes to one file: `tickets-import-<project>.json`. `tickets.import_json` is the only consumer.

```json
{
  "project_id": "demo",
  "tickets": [
    {
      "id": "T123",
      "title": "Tighten the FTS ranking",
      "description": "Scope: ...\n\nAcceptance: ...",
      "status": "open",
      "priority": "P1",
      "type": "task",
      "effort": 3,
      "epic": "Search",
      "parent_id": null,
      "created_by": "ed",
      "created_at": "2026-04-01T09:00:00.000Z",
      "closed_at": null,
      "tags": ["fts", "ranking"]
    }
  ],
  "relations": [
    { "from": "T123", "to": "T112", "kind": "follows_up", "note": null }
  ]
}
```

Contract:

- `project_id` must match an already-registered project. Importer aborts otherwise.
- Three-pass write inside one transaction: (1) insert tickets with `parent_id` blanked, (2) update `parent_id` once all rows exist, (3) insert relations. Forward references inside the same file are therefore safe.
- Missing fields default per §5 (`status` → `open`, `type` → `task`, `effort`/`priority`/`epic` → NULL).
- `created_at` is honoured if supplied (parsers reconstruct it from narrative dates) and defaulted to import time otherwise.
- `dry_run: true` validates and returns `{ counts: { tickets, relations, tags }, warnings }` without mutating.
- Duplicates: `(project_id, id)` collisions surface in `warnings` and abort the live import unless `force: true`.
- Audit log on live import: every inserted ticket gets a `_created` row stamped with `changed_at = created_at` so `changed_since` still tells the truth for back-dated history.

### Per-project parser

One small TypeScript parser per source format. Each emits the JSON intermediate above; the generic `tickets.import_json` MCP tool ingests it.

**demo parser:**
- `### T123 — Title` heading -> `id` + `title`
- `**Status:** ... ✅ Done` -> `status=done`, parse `closed_at` from inline dates
- `**Blockers:** T2, T5` -> relations of kind `blocks` (after all tickets exist, second pass)
- `**Scope:** ... **Acceptance:** ...` -> concatenated into `description`
- The "Shipped (full list)" paragraph is the canonical source for `status=done` + narrative ship-notes; these append to the per-ticket description
- T123 → T129 follow-up mentions in shipped notes -> relations of kind `follows_up`
- "T41 superseded by T70" -> relation of kind `supersedes`
- `P0`/`P1`/`P2`/`P3` from section headings -> `priority`
- Section names ("Foundation", "Auth + linking") -> `epic`

**sample parser:**
- `### NAMESPACE-NN: Title — STATUS` heading -> `id` + `title` + `status` (inline "DONE" or absent=open)
- `## Epic N: ...` heading context -> `epic`
- `> Output: ...` blockquotes -> appended to `description`
- `**Blocked by:**` -> relations of kind `blocks`
- The `BUG-/UX-/FEAT-/DESIGN-` prefix -> `type` mapping (BUG→`bug`, FEAT→`task`, etc.) and a tag

### Migration flow

1. Implement the MCP server + schema + core tools.
2. Write the demo parser, dry-run the import, eyeball the JSON intermediate.
3. `tickets.register_project({ id: "demo", root_path: "~/Scripts/demo" })`.
4. `tickets.import_json({ file: "...", dry_run: true })` -> review row counts, warnings.
5. `tickets.import_json({ file: "...", dry_run: false })`.
6. Delete `~/Scripts/demo/.ai/TICKETS.md`.
7. Repeat 2-6 for sample.
8. acme: skip migration. Project can be registered later if it starts using the MCP.

### Open migration decisions (defaults committed)

- **Commit IDs (e.g. `commit 20d91af`) inside ticket bodies**: preserved verbatim in `description`, not parsed into a structured field.
- **Already-superseded tickets** (demo T41 "superseded by T70"): row is created with `status=done`, a `T70 supersedes T41` relation (per the direction convention in §5) is added in the second pass.
- **Tickets with no acceptance criteria block**: `description` field is the concatenated scope + ship-notes; `acceptance_criteria` is not a separate column.
- **`closed_at` from narrative ship-notes**: a date like "shipped 2025-12-15" is normalised to `2025-12-15T00:00:00.000Z`. When no date is parseable, `closed_at` is left NULL and `status=done` is still authoritative.
- **`created_by` during migration**: defaulted to `"migrated:<project_id>"` so post-migration audit reports can distinguish historical rows from anything Claude or Ed adds afterwards.

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
|   |       +-- demo.ts
|   |       +-- sample.ts
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
| `tickets.stats` | <150 tokens | Counts + point totals |
| `tickets.get` single ticket | <2000 tokens typical, <5000 hard cap | Full description varies wildly |
| `tickets.next` | <300 tokens | Single ticket summary + reason |
| `tickets.changed_since` (24h) | <1000 tokens | Compact audit slice |
| Server cold-start to first response | <500ms | Includes DB open + migration check |
| SQLite query latency (any read tool) | <50ms p99 | Indexes cover all common predicates |

Token costs measured against a populated demo import (~130 tickets, ~30 relations).

## 11. Out of scope for v1

Listed explicitly so they don't creep in:
- ~~Markdown export / TICKETS.md regeneration.~~ *→ Moved in-scope 2026-05-30 (T21): delivered as `tickets.export`, an explicitly drift-labelled snapshot (see §3 principle 2). The DB remains canonical.*
- ~~CLI surface.~~ *→ Moved in-scope 2026-05-31 (T22–T26): delivered as a dual-mode `ticketgraph <command>` front-end over the same tool registry the MCP uses. Driven by token efficiency (CLI costs ~0 context until used vs the MCP's always-on schema tax); the MCP becomes opt-in. See §3 principle 5.*
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
| Migration parsers miss edge cases in dense demo narrative | Dry-run + JSON eyeball before live import; manual fixups via `tickets.update` after |
| FTS5 ranking poor on symbol-heavy ticket bodies | Porter stemming is well-tested; if relevance is weak, switch to `unicode61` only + custom prefix queries. Listed as a v1.1 follow-up if needed. |
| Global DB grows large, sqlite vacuum needed | Negligible at ~500 tickets and ~5000 audit rows. Re-evaluate at 10k+. |
| `better-sqlite3` native build breaks on macOS upgrade | Pin to a known-good version; CI smoke test on macOS runner. |
| Project_id collision when registering | UNIQUE on `root_path` and PRIMARY KEY on `id`; `register_project` rejects duplicates with a clear error. |
| Audit log unbounded growth | Single user, ~10 writes/day -> negligible. Add `audit.purge_before` tool only if it becomes a real problem. |
| Two Claude Code sessions launch concurrent MCP server processes against the same DB | SQLite WAL mode (set in §9 startup) supports many concurrent readers and one writer. Writes use `BEGIN IMMEDIATE` so lock contention surfaces as a fast `SQLITE_BUSY` rather than a stalled transaction. Acceptable for v1; if it becomes painful, the fix is an in-process advisory lock keyed off the DB path. |
| Description audit rows bloat the audit log | Overwrites store the full new description; appends store only the appended chunk. The dominant write pattern (accreting ship-notes) is append, so the worst case is bounded. Re-evaluate if `audit_log` crosses ~10 MB. |

## 14. Implementation order (suggested for writing-plans)

1. Scaffold TypeScript project, MCP stdio server skeleton, better-sqlite3 wiring.
2. Migrations runner + `001_init.sql`.
3. Core read tools: `register_project`, `add` (manual), `list`, `get`, `stats`. Smoke-test by hand.
4. Search: `tickets_fts` triggers (keep FTS in sync with tickets table), `search`.
5. Writes: `update`, `append_to_description`, `link`/`unlink`, `set_parent`, tags. Audit log writes.
6. Convenience tools: `next`, `related`, `blockers_of`, `children_of`, `changed_since`, `validate`.
7. Migration: `import_json` tool + demo parser. Dry-run, eyeball, live import.
8. Migration: sample parser. Same loop.
9. Plugin manifest + install path.
10. README + minimal usage docs.

## 15. Effort sizing guide (operational, for Claude)

Ed will not assign effort values. Claude will. This section is the reference rubric Claude consults when calling `tickets.add` or `tickets.update` with an `effort` value. It is operational documentation, not aspirational.

### The scale

| Points | Meaning | Anchors |
|---|---|---|
| **1** | Trivial, mechanical. ~15 min of focused work. | Rename a field. Update a doc string. Fix a typo'd condition. Add a flag default. One-line bugfix with obvious cause. |
| **2** | Small, isolated. One module. ~30-60 min. | Add an optional parameter to an existing tool. Write a small parser helper. Fix a bug that needs one new test. |
| **3** | Normal day's work. The default for "I know what to do, it's just work." A few files, a handful of tests. | Add a new MCP read tool with tests. Focused refactor across 3-5 files. Add a non-trivial validation rule. |
| **5** | Meaty. 2-3 modules, multiple test cases, some design judgement required. Half a day or so. | Implement `tickets.import_json` end-to-end. Add a new schema migration with backfill. Build the FTS5 trigger set. |
| **8** | Big. Substantial integration, multiple non-obvious decisions, likely a full day of focused work. | Build a project parser (demo or sample). Wire up audit logging across all writes. Stand up the migrations runner from scratch. |
| **13** | Should probably be split. Reserved escape valve. | "Build the MCP server." "Migrate everything." If you're tempted to use 13, decompose first. |

### Rules of application

1. **Anchor against done work, not unstarted work.** "Compared to a ticket already marked 3, is this more or less?" beats "how long will this take?" — Claude is bad at wall-clock estimates and good at relative comparisons.
2. **NULL beats wrong.** If scope is unclear (spike-y, exploratory, unbounded), leave `effort` unset. The audit log will record when it's filled in later.
3. **Effort is about the work, not the wait.** A blocked ticket doesn't get bigger because it's blocked. Don't inflate for risk; that's what `priority` and the `blocks` relation are for.
4. **Re-estimate on material scope change.** If a ticket's description grows substantially or its acceptance criteria shift, update the effort. The audit log captures the delta automatically.
5. **Bug effort = the fix, not the diagnosis.** Spike-then-fix is two tickets: the spike is a `spike` type at the effort it deserves (often 2-3), the fix is a separate ticket sized when scope is known.
6. **Umbrella tickets are NULL.** Effort lives on the children. An umbrella with effort would double-count when summed.
7. **13 requires a reason.** If you assign 13, leave a one-line note in the description explaining why it can't be split today. Treat unexplained 13s as a bug to fix on next visit.

### Calibration sanity checks

When running `tickets.stats`, watch for these signals that the rubric is drifting:

- **Most tickets are 3s.** 3 is the default, not the answer. If >60% of open tickets are 3, push harder to differentiate.
- **An epic sums to >40 points.** Probably scoped too wide. Suggest splitting.
- **A single project's open-work total feels off** (e.g. demo at 200+ points). Either backlog has accumulated and needs triage, or values have crept upward over time. Spot-check a handful of old vs new tickets.
- **No 1s or 2s anywhere.** Either Claude is over-estimating small work or those tickets aren't getting captured (closed too fast to write down).

### Worked examples (using ticketgraph's own implementation order from §14)

These are the values Claude should assign to ticketgraph's own implementation tickets, calibrated against the rubric above:

| §14 step | Rough effort |
|---|---|
| 1. Scaffold TS project + MCP skeleton + better-sqlite3 wiring | 5 |
| 2. Migrations runner + `001_init.sql` | 3 |
| 3. Core read tools (`register_project`, `add`, `list`, `get`, `stats`) | 8 (or split: register=2, add=2, list=3, get=3, stats=3) |
| 4. Search: FTS triggers + `search` tool | 5 |
| 5. Writes (`update`, `append`, `link`/`unlink`, `set_parent`, tags) + audit | 8 |
| 6. Convenience tools (`next`, `related`, `blockers_of`, `children_of`, `changed_since`, `validate`) | 8 (likely split) |
| 7. demo import (parser + dry-run + live) | 8 |
| 8. sample import (parser, reusing import_json) | 5 |
| 9. Plugin manifest + install path | 2 |
| 10. README + minimal usage docs | 2 |

If when actually doing the work these turn out wildly off, update the rubric — the goal is calibrated future estimates, not preserving the initial guess.

## 16. Testing strategy

The §10 acceptance budgets are assertion-backed, not eyeballed. Every ticket lands with the tests that enforce its slice of those budgets.

- **TDD throughout.** Write the failing test (or the test that captures the bug) first, then the minimum code that turns it green. No ticket closes without the test that failed before the change.
- **Single runner: vitest.** Configured in T1; ESM, Node environment, coverage opt-in via `npm test -- --coverage`.
- **Three layers, all required:**
  - **Unit** — pure functions only: parser heuristics, ID inference, FTS query sanitisation, audit-row shaping, time-format helpers. Fast, no I/O.
  - **Integration** — the stdio MCP harness from T2, running against real `better-sqlite3` with real triggers. Each test gets a fresh temp DB (`TICKETGRAPH_DB_PATH=$(mktemp -d)/test.db`); tests never touch the live `~/.claude/tickets.db`.
  - **Budget** — response size measured against a seeded fixture (`tests/fixtures/seed-100.sql`, ~100 tickets / ~30 relations / ~50 audit rows). Each tool's §10 budget is an `expect(bytes).toBeLessThan(budget * 4)` assertion (bytes-over-4 is a conservative token proxy; §10 margins are wide enough that exact tokenisation isn't worth the dependency). Latency p99s are asserted with the same fixture.
- **Parser fixtures are version-controlled.** demo and sample parser tests load from `tests/fixtures/demo/*.md` and `tests/fixtures/sample/*.md`, never the user's live `~/Scripts/<project>/.ai/TICKETS.md`. The live file changes underneath the tests and would make them flaky.
- **Acceptance bullets in `TICKETS.md` are test specs.** Each Acceptance bullet maps to one named `describe`/`it`. No bullet without a test, no test without a bullet. `/review-implementation` enforces the round-trip.
- **CI: GitHub Actions** (`.github/workflows/ci.yml`, ticket T13). Matrix: Node 20 LTS on `ubuntu-latest` and `macos-latest`. The macOS runner is non-negotiable — it catches the §13 `better-sqlite3` native-build risk before Ed hits it on his own machine. Workflow body: `npm ci && npm run build && npm test`. Local `npm test` green is still the developer gate; CI is the second opinion for macOS-specific breakage and reviewer-side regressions.

---

End of spec.
