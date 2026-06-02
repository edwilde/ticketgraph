# ticketgraph

token-efficient ticket tracking for Claude, backed by SQLite + FTS5

[![CI](https://github.com/edwilde/ticketgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/edwilde/ticketgraph/actions/workflows/ci.yml)

---

## Problem

Dense `.ai/TICKETS.md` files cost a full-file read every time a ticket topic comes up. A large project file can run to 25,000 tokens — and Claude reads all of it just to answer "what's open?". That's a poor token economy for what is fundamentally a structured-data question.

ticketgraph makes every common ticket query cost hundreds of tokens, not tens of thousands. Every response from `tickets.list`, `tickets.search`, `tickets.stats`, `tickets.next`, and `tickets.changed_since` fits in under 2k tokens by default. Full descriptions are returned only when you ask for them explicitly (`tickets.get`).

---

## What it is

A Claude Code plugin that provides token-efficient ticket queries over one global SQLite database at `~/.claude/tickets.db`. As of v0.4.0, the primary interface is the CLI — `ticketgraph <command>` — which works with zero MCP overhead. The MCP server (23 tools) is still available but is now **opt-in**.

Single-user. Single-machine. No web service, no telemetry, no external APIs.

> **v0.4.0 change:** The MCP server no longer auto-connects when the plugin loads. A fresh Claude Code session pays ~0 context until a query is made. To re-enable the MCP server, see [docs/install.md — Enabling the MCP server](docs/install.md#enabling-the-mcp-server-optional).

---

## Install

```sh
git clone https://github.com/edwilde/ticketgraph.git
cd ticketgraph
npm install
npm run build
npm run setup
```

Then restart Claude Code (or run `/reload-plugins` if already open).

For prerequisites, plugin mode, manual registration, and troubleshooting, see [docs/install.md](docs/install.md).

> **Note:** npm and Claude Code marketplace distribution are planned but not yet available. Use the dev install above.

---

## Project scoping

ticketgraph automatically resolves the active project from your current workspace. When you call a tool without an explicit `project` argument, the server checks the MCP client's advertised workspace roots and matches them against registered `root_path` values using longest-prefix matching.

- **Omit `project`** — auto-resolves from your open workspace.
- **Pass `project: "<id>"`** — override to a specific project.
- **Pass `project: "all"`** — cross-project reads (supported on `tickets.list`, `tickets.search`, `tickets.stats`).

If no registered project matches your workspace, the tool returns a structured error pointing you at `tickets.register_project`.

---

## CLI

As of v0.4.0 ticketgraph ships a dual-mode binary: no arguments / `--mcp` starts the MCP stdio server; `ticketgraph <command> [--flags]` runs a single command and exits.

```sh
ticketgraph list                       # open/in_progress/blocked tickets (compact)
ticketgraph get T7                     # full ticket detail
ticketgraph search --q "auth"          # FTS5 full-text search
ticketgraph next                       # highest-priority unblocked ticket
ticketgraph stats                      # counts + point totals
ticketgraph --help                     # all commands and global flags
ticketgraph list --help                # per-command flags
```

**Output formats:** `--format compact` (default), `--format json` (machine-readable), `--format table`.

**Structured input:** `--json '<obj>'` passes the full args object directly (required for `add_many`); `--json -` reads from stdin.

**Project resolution:** `--project <id>` overrides; omit to resolve from cwd; `--project all` on read commands queries across all projects.

**Verbosity / debug:** `--verbose` or `TICKETGRAPH_DEBUG=1`.

**Exit codes:** 0 success, 1 runtime error, 2 usage/input error.

For full CLI documentation and the recommended one-line `CLAUDE.md` snippet for downstream users, see [docs/usage.md](docs/usage.md#cli).

---

## Usage

Three example queries that cover the most common cases:

| Prompt | Tool call |
|---|---|
| "show me my open P0s" | `tickets.list({ priority: "P0" })` |
| "what's blocking T7?" | `tickets.blockers_of({ id: "T7" })` |
| "find tickets about FTS" | `tickets.search({ q: "FTS" })` |

For more examples covering add, update, next, stats, changed_since, and cross-project queries, see [docs/usage.md](docs/usage.md).

Bundled slash commands: `/ticketgraph:tickets-add|status|next|open|done` — see [docs/usage.md](docs/usage.md#slash-commands).

---

## Tool reference

> This table covers the 23 tools registered as of T21. If tools are added in future, update this table.

### Read tools

| Tool | Description |
|---|---|
| `tickets.list` | List tickets with filters (status, priority, type, epic, tag, blocked_by). Default: open/in_progress/blocked. Supports `project: "all"`. |
| `tickets.get` | Fetch one or more full tickets including tags and relations. Audit history is opt-in: pass `include_audit: true` (CLI `--include_audit`). |
| `tickets.search` | Full-text search (FTS5 BM25) over titles and descriptions. Supports `project: "all"`. |
| `tickets.next` | Return the highest-priority open ticket with no open blockers. |
| `tickets.related` | All tickets related to a given ticket, both directions, grouped by kind. |
| `tickets.blockers_of` | Tickets that block a given ticket, traversed recursively (incoming `blocks` edges). |
| `tickets.children_of` | Descendant tickets by walking `parent_id` links downward. |
| `tickets.changed_since` | Audit log slice for all changes since a given ISO timestamp. |
| `tickets.stats` | Counts grouped by status, priority, epic, type, and effort. Supports `project: "all"`. |

### Write tools

> Write tools return a **lean** shape by default (e.g. `add` → `{ id, status, created_at }`); pass `full: true` (CLI `--full`) for the complete ticket row.

| Tool | Description |
|---|---|
| `tickets.add` | Create a new ticket. Auto-generates an id if omitted. Returns `{ id, status, created_at }`; `full: true` returns the full row. |
| `tickets.add_many` | Create many tickets in one transaction (auto-ids, intra-batch parent/relations). All-or-nothing; returns created ids. |
| `tickets.update` | Patch any subset of a ticket's mutable fields. Writes one audit row per changed field. Returns `{ id, changed, closed_at?, audit_entries }`; `full: true` returns the full row. |
| `tickets.append_to_description` | Append text to a ticket's description. |

### Convenience tools

| Tool | Description |
|---|---|
| `tickets.link` | Create a directed typed relation between two tickets. |
| `tickets.unlink` | Remove a directed typed relation. |
| `tickets.set_parent` | Set or clear a ticket's parent, with cycle detection. |
| `tickets.add_tag` | Add a tag to a ticket (idempotent). |
| `tickets.remove_tag` | Remove a tag from a ticket (idempotent). |

### Admin tools

| Tool | Description |
|---|---|
| `tickets.register_project` | Register a project with an id, display name, and root path. |
| `tickets.validate` | Run integrity checks (orphan parents, dangling relations, closed_at consistency). |
| `tickets.ping` | Liveness check. Returns `{ ok, version, db_path, schema_version }`. |

### Migration

| Tool | Description |
|---|---|
| `tickets.import_json` | Import tickets from a JSON intermediate file. Supports `dry_run` and `force`. |
| `tickets.export` | Write a drift-labelled markdown snapshot of the project's tickets (default `<root>/.ai/TICKETS.md`), with a generated-at banner naming the DB as the source of truth. **Overwrites** the target. |

For full parameter documentation, see [§6 of the design spec](docs/specs/2026-05-28-ticketgraph-design.md).

---

## Migration

If you have an existing `.ai/TICKETS.md`, ticketgraph can ingest it. The model: the MCP becomes the canonical store; TICKETS.md is migrated once and then deleted. For a read-only view, `tickets.export` can regenerate a `.ai/TICKETS.md` snapshot — but it carries a loud generated-at banner and the DB stays the source of truth (it is never re-ingested).

Built-in parsers ship for demo and sample formats. Other formats need a small parser to the JSON intermediate shape.

See [docs/migration.md](docs/migration.md) for the full flow and [docs/import-format.md](docs/import-format.md) for the JSON schema.

---

## Development

```sh
npm test          # run all tests (vitest)
npm run build     # compile TypeScript to dist/
npm run typecheck # tsc --noEmit
```

Design decisions, schema, tool contracts, and project-resolution algorithm: [docs/specs/2026-05-28-ticketgraph-design.md](docs/specs/2026-05-28-ticketgraph-design.md).

---

## Licence

MIT — see [LICENSE](LICENSE).
