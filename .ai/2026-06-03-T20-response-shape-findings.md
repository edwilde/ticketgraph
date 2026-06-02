# T20 — Response-Shape Token-Efficiency Findings

**Date:** 2026-06-03
**Ticket:** T20 (spike → enhancement). Question: *is there scope to cut response token count without losing key data?*
**Method:** Inventoried every registered tool's `handle()` return shape (`src/tools/*.ts`), classified each returned field, and measured where the cost is actually realised.

---

## Key architectural finding (reshapes the whole audit)

Token cost is **not** uniform across output paths:

- **CLI compact (the default output):** `cli/format.ts` renders a ticket-shaped row as **only 6 columns** — `id, status, priority, type, effort, title` (`format.ts:30-37`). `isTicketRow` (`format.ts:72`) requires all six present; otherwise the result degrades to `compactObject` `key=value` lines. So the extra 7 fields on a full ticket row (`description, project_id, epic, parent_id, created_by, created_at, closed_at`) **cost nothing in compact** — they are never rendered.
- **MCP path:** `server.ts:76` emits raw `JSON.stringify(result)` — the **entire** `TResult`, every field.
- **CLI `--format json`:** same — full `TResult`.

**Conclusion:** trimming a tool's `TResult` shape is the only change that reduces tokens on the MCP and JSON paths. It also marginally helps compact for *non*-ticket-shaped results (fewer `key=value` lines). The trims below therefore target the `handle()` return type, not the formatter.

### Classification key
- **(a) new** — information the caller did not send (assigned id, server defaults, computed counts, trigger-driven values, relations, audit).
- **(b) echo** — a value the caller just supplied in the request.
- **(c) derivable** — fixed/known-from-context (e.g. `closed_at` is always null on create; `project_id` is the resolved scope the caller chose).

### Opt-in flag naming (locked)
The opt-in-full flag is **`full`** (CLI `--full`), **never `verbose`** — `--verbose` is a reserved global CLI flag stripped from argv before command parsing (`index.ts:96-98`) and would never reach a handler. `get`'s audit gate is `include_audit`.

---

## Per-tool findings (all 23 registered tools)

### Write tools — TRIM

| Tool | Current return | New (a) | Echo (b) | Derivable (c) | Decision | Risk |
|---|---|---|---|---|---|---|
| **`tickets.add`** (`add.ts:51`) | full 13-field `{ ticket }` | `id`, `status`*, `created_at` | `title, description, priority, type, effort, epic, parent_id, created_by`* | `project_id` (chosen scope), `closed_at` (null on create) | **TRIM** → default `{ id, status, created_at }`; `full:true` → unchanged 13-field `{ ticket }` | Low — only new datum the caller can't reconstruct is `id`. `*status`/`created_by` may be server defaults but are echoable. |
| **`tickets.update`** (`update.ts:70`) | full 13-field `{ ticket, audit_entries }` | which fields changed, trigger-driven `closed_at`, `audit_entries` | the patched field values | unchanged fields | **TRIM** → default `{ id, changed: string[], closed_at?, audit_entries }`; `full:true` → unchanged `{ ticket, audit_entries }` | Medium — **must** still surface `closed_at` when a status→done/deferred transition fires the trigger (genuinely new). Covered by decision. |
| **`tickets.set_parent`** (`set_parent.ts:40`) | `{ ticket(full), changed }` | `changed` | `parent_id` (sent) | rest of row | **TRIM** → default `{ id, parent_id, changed }`; `full:true` → `{ ticket, changed }` | Low. |
| **`tickets.append_to_description`** (`append_to_description.ts:41`) | full 13-field `{ ticket }` | resulting concatenated `description` | rest of row | — | **TRIM** → default `{ id, description }`; `full:true` → full `{ ticket }` | Low — caller may want the merged description, which the lean shape keeps. |

### Read tool — GATE

| Tool | Current return | Decision | Risk |
|---|---|---|---|
| **`tickets.get`** (`get.ts:55`) | full row + `tags[]` + `relations{}` + `recent_audit[≤10]` | **GATE**: add `include_audit:false` (default) → omit the `recent_audit` key entirely; `include_audit:true` → today's `recent_audit`. **Relations and tags stay default-on** — they are the usual reason to `get` a ticket in depth and fit the 8000-byte budget. | Low — audit is the heaviest rarely-needed payload; omitting the key (not returning `[]`) is leanest and signals "ask for it". |

### NO-CHANGE — already lean (recorded, not silently skipped)

| Tool | Return | Reason for no change |
|---|---|---|
| `tickets.add_many` (`add_many.ts:53`) | `{ created: string[], count, warnings? }` | Already the lean shape this audit endorses for `add`; IDs only. |
| `tickets.next` (`next.ts:36`) | 10-field row + `reason` | READ tool — the row **is** the answer; already omits `description`/`epic`/`created_by`. |
| `tickets.list` (`list.ts:34`) | `{ project, count, rows }`; `description` gated by `include_description` | Default already omits description; shape is lean. **Gap:** no budget test exists — Task 4 adds one (not a shape change). |
| `tickets.search` (`search.ts:44`) | `hits[]` (id, title, status, priority, type, snippet); limit 10 | Bounded list, snippet ≤240 chars, budget-tested (<4000B). |
| `tickets.related` (`related.ts:35`) | grouped `RelatedItem[]` | Bounded by depth; budget-tested (<4000B). |
| `tickets.blockers_of` (`blockers_of.ts:32`) | `{ id, blockers[] }` (id,title,status,depth) | Minimal per-item fields. |
| `tickets.children_of` (`children_of.ts:33`) | `{ id, children[] }` (id,title,status,parent_id,depth) | Minimal per-item fields. |
| `tickets.changed_since` (`changed_since.ts:34`) | `{ project, count, changes[] }` | Audit slice only; budget-tested (<4000B). |
| `tickets.validate` (`validate.ts:26`) | `{ project, ok, issues[] }` | Report only; budget-tested (<2000B). |
| `tickets.link` (`link.ts:29`) | 5-field relation metadata | Minimal. |
| `tickets.unlink` (`unlink.ts:22`) | `{ removed: true }` | Single field. |
| `tickets.add_tag` / `tickets.remove_tag` | `{ tags: string[] }` | The resulting tag set is the only meaningful return. |
| `tickets.register_project` (`register_project.ts:26`) | 4-field project metadata | Minimal, infrequent. |
| `tickets.ping` (`ping.ts:18`) | `{ ok, version, db_path, schema_version }` | Liveness payload; all 4 are new info. |
| `tickets.export` (`export.ts:29`) | `{ path, bytes, ticket_count, exported_at }` | Metadata only. |

### WON'T-DO — could be trimmed, deliberately not (with reason)

| Tool / field | Why it was a candidate | Why won't-do |
|---|---|---|
| `tickets.stats` — 5 `by_*` maps + totals | Several maps could be large at high cardinality | Every field is **computed aggregate (a) new info**; nothing is echo. Cardinality is bounded by status/priority/type enums; only `by_epic` is open-ended and is the user's own data. Trimming would lose the answer. |
| `tickets.next` row | Returns a 10-field row | The row is the tool's entire purpose ("what should I work on") — the caller wants to *see* the ticket, not just its id. |
| `add_many` / `import_json` `warnings[]` | Warnings array can grow large | **Load-bearing on failure** — dropping or capping warnings hides exactly the information the caller needs when a batch partially fails. Keep verbatim. |

---

## Accepted-change summary

| Tool | Default shape (lean) | Opt-in flag | Opt-in shape |
|---|---|---|---|
| `add` | `{ id, status, created_at }` | `full:true` | `{ ticket }` (13 fields) |
| `update` | `{ id, changed[], closed_at?, audit_entries }` | `full:true` | `{ ticket, audit_entries }` |
| `set_parent` | `{ id, parent_id, changed }` | `full:true` | `{ ticket, changed }` |
| `append_to_description` | `{ id, description }` | `full:true` | `{ ticket }` |
| `get` | full row + tags + relations (no `recent_audit`) | `include_audit:true` | + `recent_audit[≤10]` |

**Invariant:** no datum becomes unrecoverable — every trimmed field remains reachable via `full:true` / `include_audit:true`. Default shapes must keep existing per-tool token budgets green and tighten them where the default got leaner (Task 4).

## Measured byte deltas

> Populated by Task 4 from `Buffer.byteLength(JSON.stringify(result),"utf8")` on each tool's seeded fixture (before vs. after the trim). Recorded here as the AC's "measured token deltas per changed tool".

BEFORE = the equivalent full/old shape (`full:true` for write tools — equals the old default; `include_audit:true` for `get` — equals the old default). AFTER = the lean default. Each measured on the same seeded fixture used by that tool's budget test.

| Tool | Before (bytes) | After (bytes) | Δ | % reduction |
|---|---|---|---|---|
| `add` | 250 | 67 | −183 | −73.2% |
| `update` | 281 | 89 | −192 | −68.3% |
| `set_parent` | 260 | 43 | −217 | −83.5% |
| `append_to_description` | 267 | 54 | −213 | −79.8% |
| `get` (default) | 1299 | 312 | −987 | −76.0% |

Notes:
- `get` BEFORE uses `include_audit:true` with 10 audit rows (the old always-on `recent_audit[≤10]`); AFTER omits the `recent_audit` key entirely.
- Write-tool BEFORE numbers are the `full:true` 13-field `{ ticket }` shape, which is byte-identical to the pre-T20 default return.
- `list` has no before/after row: its shape did not change in T20 (task 4c added a budget guard only). Measured default page (30 open tickets, no description) ≈ 6111 bytes.
