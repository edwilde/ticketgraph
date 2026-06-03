# ticketgraph

token-efficient ticket tracking for Claude, backed by SQLite + FTS5

[![CI](https://github.com/edwilde/ticketgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/edwilde/ticketgraph/actions/workflows/ci.yml)

---

## Problem

Dense `.ai/TICKETS.md` files cost a full-file read every time a ticket topic comes up. A large project file can run to 25,000 tokens — and Claude reads all of it just to answer "what's open?". That's a poor token economy for what is fundamentally a structured-data question.

ticketgraph makes every common ticket query cost hundreds of tokens, not tens of thousands. Every response from `list`, `search`, `stats`, `next`, and `changed_since` fits in under 2k tokens by default. Full descriptions are returned only when you ask for them explicitly (`get`).

---

## Quick start (CLI)

```sh
git clone https://github.com/edwilde/ticketgraph.git
cd ticketgraph
npm install
npm run build
npm run setup
```

Then run a command — the CLI is the default interface and exits immediately, with zero MCP overhead:

```sh
ticketgraph list                       # open/in_progress/blocked tickets (compact)
ticketgraph next                       # highest-priority unblocked ticket
ticketgraph search --q "auth"          # FTS5 full-text search
ticketgraph get T7                     # full ticket detail
ticketgraph stats                      # counts + point totals
ticketgraph --help                     # all commands and global flags
```

Pass `--format json` to any read command for machine-readable output (`--format compact` is the default, `--format table` also available).

For prerequisites, plugin mode, manual registration, and troubleshooting, see [docs/install.md](docs/install.md).

> **Note:** npm and Claude Code marketplace distribution are planned but not yet available. Use the dev install above.

---

## What it is

A token-efficient ticket store over one global SQLite database at `~/.claude/tickets.db`. As of v0.4.0, the primary interface is the CLI — `ticketgraph <command>` — which works with zero MCP overhead. The MCP server is still available but is now **opt-in**.

Single-user. Single-machine. No web service, no telemetry, no external APIs.

**Token economy:** every common query fits in under 2k tokens by default, and the CLI costs ~0 context until you actually run a command — there's no always-on schema tax the way an always-connected MCP server would charge against every session.

---

## Common commands

The CLI command names map 1:1 to the underlying tools.

### Read

| Command | Description |
|---|---|
| `list` | List tickets with filters (status, priority, type, epic, tag, blocked_by). Default: open/in_progress/blocked. Supports `--project all`. |
| `get` | Fetch one or more full tickets including tags and relations. Audit history is opt-in via `--include_audit`. |
| `search` | Full-text search (FTS5 BM25) over titles and descriptions. Supports `--project all`. |
| `next` | Return the highest-priority open ticket with no open blockers. |
| `stats` | Counts grouped by status, priority, epic, type, and effort. Supports `--project all`. |
| `related` | All tickets related to a given ticket, both directions, grouped by kind. |
| `blockers_of` | Tickets that block a given ticket, traversed recursively. |
| `children_of` | Descendant tickets by walking `parent_id` links downward. |
| `changed_since` | Audit log slice for all changes since a given ISO timestamp. |
| `validate` | Run integrity checks (orphan parents, dangling relations, closed_at consistency). |
| `ping` | Liveness check. Returns `{ ok, version, db_path, schema_version }`. |

### Write

> Write commands return a **lean** shape by default (e.g. `add` → `{ id, status, created_at }`); pass `--full` for the complete ticket row.

| Command | Description |
|---|---|
| `add` | Create a new ticket. Auto-generates an id if omitted. |
| `add_many` | Create many tickets in one transaction (auto-ids, intra-batch parent/relations). All-or-nothing. Pass the batch via `--json`. |
| `update` | Patch any subset of a ticket's mutable fields. Writes one audit row per changed field. |
| `append_to_description` | Append text to a ticket's description. |

### Convenience

| Command | Description |
|---|---|
| `link` / `unlink` | Create or remove a directed typed relation between two tickets. |
| `set_parent` | Set or clear a ticket's parent, with cycle detection. |
| `add_tag` / `remove_tag` | Add or remove a tag on a ticket (idempotent). |

### Admin & migration

| Command | Description |
|---|---|
| `register_project` | Register a project with an id, display name, and root path. |
| `import_json` | Import tickets from a JSON intermediate file. Supports `dry_run` and `force`. |
| `export` | Write a drift-labelled markdown snapshot of the project's tickets (default `<root>/.ai/TICKETS.md`). **Overwrites** the target. |

**Structured input:** `--json '<obj>'` passes the full args object directly (required for `add_many`); `--json -` reads from stdin.

**Project resolution:** `--project <id>` overrides; omit to resolve from cwd; `--project all` on read commands queries across all projects.

**Verbosity / debug:** `--verbose` or `TICKETGRAPH_DEBUG=1`. **Exit codes:** 0 success, 1 runtime error, 2 usage/input error.

For full CLI documentation and per-command flags, see [docs/usage.md](docs/usage.md#cli). For full parameter documentation, see [§6 of the design spec](docs/specs/2026-05-28-ticketgraph-design.md).

---

## Using with Claude

The cheap path for agents is to point them at the CLI from your project's `CLAUDE.md`, so Claude reaches for `ticketgraph <command>` instead of reading the ticket file:

```md
Token-cheap ticket queries via `ticketgraph <command>` (read: list, get, search, next, stats, changed_since, blockers_of, children_of, related, validate, ping). Prefer this over reading `.ai/TICKETS.md`. Use `--format json` to parse output.
```

Bundled slash commands: `/ticketgraph:tickets-add|status|next|open|done` — see [docs/usage.md](docs/usage.md#slash-commands).

---

## Project scoping

ticketgraph automatically resolves the active project from your current workspace. When you call a command without an explicit `--project`, it matches your cwd (or, under MCP, the client's advertised workspace roots) against registered `root_path` values using longest-prefix matching.

- **Omit `--project`** — auto-resolves from your open workspace.
- **`--project <id>`** — override to a specific project.
- **`--project all`** — cross-project reads (supported on `list`, `search`, `stats`).

If no registered project matches, the command returns a structured error pointing you at `register_project`.

---

## MCP server (optional)

ticketgraph also speaks MCP for direct tool calls, but it's **opt-in**. As of v0.4.0 the MCP server no longer auto-connects when the plugin loads — a fresh Claude Code session pays ~0 context until a query is made.

Start it with `ticketgraph mcp` (or `ticketgraph --mcp`, or no arguments). To enable it inside Claude Code, see [docs/install.md — Enabling the MCP server](docs/install.md#enabling-the-mcp-server-optional).

---

## Migration

If you have an existing `.ai/TICKETS.md`, ticketgraph can ingest it. The model: ticketgraph becomes the canonical store; TICKETS.md is migrated once and then deleted. For a read-only view, `export` can regenerate a `.ai/TICKETS.md` snapshot — but it carries a loud generated-at banner and the DB stays the source of truth (it is never re-ingested).

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
