# ticketgraph — Usage examples

These examples show the natural-language prompts you give Claude and the tool calls it makes in response. Every call listed here matches a real tool signature — cross-checked against `src/tools/`.

---

## CLI

As of v0.4.0 ticketgraph ships a dual-mode binary: no arguments / `--mcp` starts the MCP stdio server; `ticketgraph <command> [--flags]` runs a single command and exits.

```sh
ticketgraph list                       # open/in_progress/blocked tickets (compact)
ticketgraph list --status done         # filter by status
ticketgraph get T7                     # full ticket detail
ticketgraph search --q "auth"          # FTS5 search
ticketgraph next                       # highest-priority unblocked ticket
ticketgraph stats                      # counts + point totals
ticketgraph --help                     # all commands
ticketgraph list --help                # per-command flags
```

**Output formats:** `--format compact` (default, human-readable), `--format json` (machine-readable, use to parse), `--format table`.

**Structured input:** `--json '<obj>'` passes the full args object directly (required for `add_many`); `--json -` reads JSON from stdin.

**Project resolution:** `--project <id>` overrides; omit to resolve from cwd; `--project all` on read commands queries across all projects.

**Verbosity:** `--verbose` / `TICKETGRAPH_DEBUG=1` enables INFO logging to stderr.

**Exit codes:** 0 success, 1 runtime error, 2 usage/input error.

**If not globally installed**, use the PATH-independent form:
```sh
node /absolute/path/to/ticketgraph/dist/server.js <command> [--flags]
# or with ${CLAUDE_PLUGIN_ROOT} available (slash commands):
node ${CLAUDE_PLUGIN_ROOT}/dist/server.js <command> [--flags]
```

### Recommended CLAUDE.md snippet for downstream users

Add one line to your project's `CLAUDE.md` to enable token-cheap ticket queries in any Claude Code session:

```
Token-cheap ticket queries via `ticketgraph <command>` (read: list, get, search, next, stats, changed_since, blockers_of, children_of, related, validate, ping; `ticketgraph --help` for all flags). Prefer this over reading `.ai/TICKETS.md`. Use `--format json` to parse output. MCP server is opt-in (see docs/install.md).
```

---

## Project scoping

When you call a tool without an explicit `project` argument, ticketgraph resolves the active project from your current workspace (the MCP client's advertised roots, matched against registered `root_path` values by longest-prefix). Most of the time you don't need to think about this — open a project in Claude Code and ticket queries automatically scope to it.

- Omit `project` — auto-scope from workspace.
- `project: "<id>"` — override to a specific project.
- `project: "all"` — cross-project reads (valid on `tickets.list`, `tickets.search`, `tickets.stats`).

For the resolution algorithm detail, see §4 of the [design spec](specs/2026-05-28-ticketgraph-design.md).

---

## Slash commands

Five slash commands are bundled with the plugin for the high-frequency loop. They surface as `/ticketgraph:<name>` in the Claude Code command menu after plugin load (run `/reload-plugins` in dev, or restart Claude Code after install).

| Command | What it does | CLI command |
|---|---|---|
| `/ticketgraph:tickets-add [title]` | Create a new ticket | `ticketgraph add --title "…"` |
| `/ticketgraph:tickets-status` | Show counts and point totals for the current project | `ticketgraph stats` |
| `/ticketgraph:tickets-next` | Recommended next ticket to work on (highest-priority, no open blockers) | `ticketgraph next` |
| `/ticketgraph:tickets-open` | List all open, in-progress, and blocked tickets | `ticketgraph list` |
| `/ticketgraph:tickets-done [id]` | Mark a ticket as done | `ticketgraph update --json '{"id":"…","patch":{"status":"done"}}'` |

**Activation:** after install or `/reload-plugins`, verify with `/ticketgraph:tickets-status` — it should return the current project's stats.

**Manual acceptance checklist:**
1. `/reload-plugins` (dev) or reinstall → the five commands appear under `/ticketgraph:` in the slash menu with their descriptions.
2. `/ticketgraph:tickets-add Test ticket` → creates a ticket, reports the id.
3. `/ticketgraph:tickets-status` → returns the project stats.
4. `/ticketgraph:tickets-done <id>` → flips it to done, `closed_at` set.

---

## Example prompts

### 1. Show open P0s

**Prompt:** "show me my open P0s"

**Call:**
```json
tickets.list({ "priority": "P0" })
```

**Why:** `tickets.list` filters on `priority` and defaults to status `open`, `in_progress`, `blocked` — so done tickets are excluded automatically. Returns a summary row per ticket (no descriptions), well under 2k tokens for typical backlogs.

---

### 2. What's blocking a ticket

**Prompt:** "what's blocking T7?"

**Call:**
```json
tickets.blockers_of({ "id": "T7" })
```

**Why:** `tickets.blockers_of` traverses incoming `blocks` edges recursively (depth 2 by default, max 3) and returns each blocker's id, title, and status. A flat list even if the blocker chain is deep.

---

### 3. Full-text search

**Prompt:** "find tickets about FTS"

**Call:**
```json
tickets.search({ "q": "FTS" })
```

**Why:** `tickets.search` uses SQLite FTS5 with BM25 ranking, title weighted 3x over description. Returns up to 10 hits by default with a 240-char description snippet each. Scoped to open/in_progress/blocked unless you pass `include_done: true`.

---

### 4. Add a ticket

**Prompt:** "add a ticket: tighten the ranking"

**Call:**
```json
tickets.add({ "title": "Tighten the ranking" })
```

**Why:** `tickets.add` only requires `title`. The server auto-generates the next id from the project's existing ticket ids (e.g. `T42`). Status defaults to `open`, type to `task`. Returns a lean `{ id, status, created_at }` by default; pass `full: true` (CLI `--full`) to get the complete 13-field row.

Optional fields you can add: `description`, `status`, `priority` (`P0`–`P3`), `type` (`task`, `bug`, `spike`, `followup`, `umbrella`), `effort` (Fibonacci: 1, 2, 3, 5, 8, 13), `epic`, `parent_id`, `tags`.

---

### 5. Mark a ticket done

**Prompt:** "mark T5 done"

**Call:**
```json
tickets.update({ "id": "T5", "patch": { "status": "done" } })
```

**Why:** `tickets.update` takes an `id` and a `patch` object containing only the fields to change. Each changed field writes one audit row. No-op patches (value already matches) return immediately without touching the database. Returns a lean `{ id, changed, closed_at?, audit_entries }` by default (`closed_at` appears when a status→done/deferred transition sets it); pass `full: true` (CLI `--full`) for `{ ticket, audit_entries }`.

---

### 6. What should I work on next

**Prompt:** "what should I work on next?"

**Call:**
```json
tickets.next({})
```

**Why:** `tickets.next` returns the highest-priority open ticket that has no open blockers, ranked by priority then age. Returns `{ ticket, reason }` where `reason` includes the priority, age in days, and a `no_open_blockers: true` flag. Returns `{ ticket: null, reason: null }` when nothing qualifies.

---

### 7. What changed today

**Prompt:** "what changed today?"

**Call:**
```json
tickets.changed_since({ "since": "2026-05-29T00:00:00Z" })
```

**Why:** `tickets.changed_since` slices the audit log from a given ISO timestamp. Returns each change as `{ ticket_id, field, old_value, new_value, changed_at }`, sorted newest-first. Default limit 100; max 500. The `since` value is the start of today in UTC — Claude substitutes the actual date.

---

### 8. Project summary

**Prompt:** "project summary" or "how many open tickets do we have?"

**Call:**
```json
tickets.stats({})
```

**Why:** `tickets.stats` returns counts grouped by status, priority, epic, type, and effort, plus totals (ticket count and story-point sum). Fits in a single compact response. Pass `project: "all"` for a cross-project aggregate.

---

### 9. Cross-project P0s

**Prompt:** "across all my projects, what P0s are open?"

**Call:**
```json
tickets.list({ "project": "all", "priority": "P0" })
```

**Why:** `project: "all"` is supported on read tools (`tickets.list`, `tickets.search`, `tickets.stats`) and queries across all registered projects in one call.

---

### 10. Add several tickets at once

**Prompt:** "add these five tickets: ..." or "create a batch of tickets for the auth redesign"

**Call:**
```json
tickets.add_many({
  "tickets": [
    { "id": "T50", "title": "Auth redesign: audit existing flows", "type": "spike" },
    { "id": "T51", "title": "Auth redesign: implement OAuth2 provider", "parent_id": "T50" },
    { "title": "Auth redesign: update tests" }
  ],
  "relations": [
    { "from": "T50", "to": "T51", "kind": "blocks" }
  ]
})
```

**Why:** `tickets.add_many` creates all tickets in one transaction — either all succeed or none do. Tickets that omit `id` get auto-assigned sequential ids. Tickets referenced as `parent_id` or relation endpoints within the same call must have explicit ids (auto-assigned ids aren't known at author time). Returns `{ created: ["T50", "T51", "T52"], count: 3 }`.

---

## Other useful calls

### Get a full ticket

```json
tickets.get({ "id": "T12" })
```

Returns the full ticket including description, tags, and all relations (outgoing and incoming). Recent audit history is opt-in — pass `include_audit: true` (CLI `--include_audit`) for the last 10 audit entries. For multiple tickets at once, use `ids: ["T12", "T13"]` (max 10); the `include_audit` flag applies per element.

### Link two tickets

```json
tickets.link({ "from": "T9", "to": "T7", "kind": "blocks" })
```

Creates a directed relation. Known kinds: `blocks`, `follows_up`, `supersedes`, `relates_to`. The `from` ticket is the active party — "T9 blocks T7" means T7 cannot proceed until T9 is done.

### Find related tickets

```json
tickets.related({ "id": "T7" })
```

Returns all tickets related to T7 in both directions, grouped by direction and kind. Add `kinds: ["blocks"]` to restrict to a specific relation type.

### Tag a ticket

```json
tickets.add_tag({ "id": "T5", "tag": "performance" })
```

Tags are normalised (trimmed, lowercased). Adding an already-present tag is a no-op.

### Append a note to a ticket

```json
tickets.append_to_description({ "id": "T5", "text": "Investigated — root cause is in the FTS weight configuration." })
```

Appends to the existing description using `\n\n` as the separator. Use this rather than `tickets.update` when you want to add context without replacing the whole description.

### Validate project integrity

```json
tickets.validate({})
```

Checks for orphan `parent_id` values, dangling relations, and `closed_at` inconsistencies. Returns `{ ok, issues }` — `ok` is `true` when no error-severity issues exist.

### Export a markdown snapshot

```json
tickets.export({})
```

Renders the project's tickets to a human-readable markdown file (default `<root>/.ai/TICKETS.md`; pass `path` to override) and returns `{ path, bytes, ticket_count, exported_at }` — not the body. The file opens with a loud generated-at banner: it is a point-in-time snapshot, the DB is the source of truth, and the file **will drift** until you re-run the export.

> **Overwrites** the target file every time. The export reflects only what the DB holds (fields + each ticket's `description` verbatim) — it does not reconstruct hand-authored prose that was never stored. `~` is not expanded; relative `path` resolves against the project root.
