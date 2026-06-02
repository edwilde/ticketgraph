---
name: ticketgraph
description: Use when you need to read, search, list, or manage a project's tickets, issues, or tasks — especially if the repo has an .ai/TICKETS.md file or a `ticketgraph` command on PATH. Triggers on questions like "what should I work on next", "show open/blocked tickets", "what blocks this", ticket search, status/stats, or creating/updating tickets. Query via the token-cheap ticketgraph CLI instead of reading large ticket files.
---

# ticketgraph

## Overview

`ticketgraph` is a CLI over a SQLite ticket store. It returns exactly the tickets and fields you ask for, so it is far cheaper than reading `.ai/TICKETS.md` (often thousands of lines). **Whenever you need ticket data, run `ticketgraph <command>` — do not open or grep the markdown file.** That markdown is a generated drift snapshot, not the source of truth; the database is.

## When to use

- The repo has an `.ai/TICKETS.md` file, or `ticketgraph` is on your PATH.
- You need: the next thing to work on, open/blocked tickets, a ticket's details, full-text search, stats, or dependency/parent/related links.
- You need to create, update, link, or tag tickets.

If `ticketgraph` is not on PATH, it isn't set up here — fall back to whatever the project documents. Otherwise, prefer the CLI over reading ticket files for every query.

## Quick reference — reading

| Need | Command |
|---|---|
| What to work on next (highest priority, unblocked) | `ticketgraph next` (filter by type: `ticketgraph next --type bug`) |
| Open tickets (default: open/in_progress/blocked) | `ticketgraph list` |
| Filtered list | `ticketgraph list --type bug --priority 1 --status all` |
| One ticket (full detail) | `ticketgraph get T22` |
| Several tickets | `ticketgraph get --ids T1 T2 T3` |
| Full-text search (BM25, title weighted 3×) | `ticketgraph search --q "auth redirect"` |
| Counts by status/priority/epic/type/effort | `ticketgraph stats` |
| What blocks a ticket (recursive) | `ticketgraph blockers_of T5` |
| Descendants of a ticket | `ticketgraph children_of T5` |
| Anything related (both directions) | `ticketgraph related T5` |
| Audit changes since a time | `ticketgraph changed_since --since 2026-06-01` |
| Integrity check (orphans, cycles) | `ticketgraph validate` |

## Quick reference — writing

Mutating commands (`add`, `add_many`, `update`, `link`, `unlink`, `set_parent`, `append_to_description`, `add_tag`, `remove_tag`, `import_json`, `export`) exist too. Each change writes an audit entry. Confirm exact flags with `<command> --help` before running — e.g. `ticketgraph add --title "..." --type bug`, `ticketgraph update T5 --status done`. Use `add_many` to create many tickets in one transaction via `--json '<obj>'` (or `--json -` for stdin).

## Key flags (global)

- `--format json` — machine-readable output. **Use this whenever you will parse the result.** Default is `compact` (terse, for skimming); `table` is for human display.
- `--project <id>` — target a project. Omit to resolve from the current directory; use `--project all` on read commands to query across all projects.
- `<id>` is positional for `get`, `blockers_of`, `children_of`, `related` (e.g. `ticketgraph get T22`).
- `ticketgraph --help` lists every command; `ticketgraph <command> --help` shows that command's exact flags.

## Common mistakes

- Reading or grepping `.ai/TICKETS.md` to answer a query → use the CLI; the markdown is a generated snapshot, not the store.
- Parsing `compact` output programmatically → add `--format json`.
- Guessing flag names (especially for write commands) → run `ticketgraph <command> --help`.
- Assuming you must enable the MCP server → you don't. The CLI is the default, token-cheap path. The MCP server is opt-in and adds a persistent per-turn context cost (all tool schemas loaded every turn); only enable it when you specifically want native `tickets.*` tool calls without shell invocations.
