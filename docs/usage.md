# ticketgraph — Usage examples

These examples show the natural-language prompts you give Claude and the MCP tool calls it makes in response. Every call listed here matches a real tool signature — cross-checked against `src/tools/`.

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

| Command | What it does | Underlying MCP tool |
|---|---|---|
| `/ticketgraph:tickets-add [title]` | Create a new ticket | `tickets.add` |
| `/ticketgraph:tickets-status` | Show counts and point totals for the current project | `tickets.stats` |
| `/ticketgraph:tickets-next` | Recommended next ticket to work on (highest-priority, no open blockers) | `tickets.next` |
| `/ticketgraph:tickets-open` | List all open, in-progress, and blocked tickets | `tickets.list` |
| `/ticketgraph:tickets-done [id]` | Mark a ticket as done | `tickets.update` |

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

**Why:** `tickets.add` only requires `title`. The server auto-generates the next id from the project's existing ticket ids (e.g. `T42`). Status defaults to `open`, type to `task`.

Optional fields you can add: `description`, `status`, `priority` (`P0`–`P3`), `type` (`task`, `bug`, `spike`, `followup`, `umbrella`), `effort` (Fibonacci: 1, 2, 3, 5, 8, 13), `epic`, `parent_id`, `tags`.

---

### 5. Mark a ticket done

**Prompt:** "mark T5 done"

**Call:**
```json
tickets.update({ "id": "T5", "patch": { "status": "done" } })
```

**Why:** `tickets.update` takes an `id` and a `patch` object containing only the fields to change. Each changed field writes one audit row. No-op patches (value already matches) return immediately without touching the database.

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

## Other useful calls

### Get a full ticket

```json
tickets.get({ "id": "T12" })
```

Returns the full ticket including description, tags, all relations (outgoing and incoming), and the last 10 audit entries. For multiple tickets at once, use `ids: ["T12", "T13"]` (max 10).

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
