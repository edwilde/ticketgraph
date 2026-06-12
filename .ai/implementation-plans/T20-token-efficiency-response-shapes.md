# T20 — Token-Efficiency Review of Tool Response Shapes — Implementation Plan

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task. Task 1 produces the findings doc (T20 AC #1) and is the spec for Tasks 2–5.

**Goal:** Cut default response token count on the write tools and `tickets.get` by returning new/server-computed information only, with full data one opt-in flag away — without making any datum unrecoverable and without loosening any existing token budget.
**Architecture:** Each tool's `handle()` returns a plain `TResult`. The MCP path (`server.ts:76`) emits raw `JSON.stringify(result)`; the CLI emits compact text by default (`cli/format.ts`) or JSON via `--format json`. Trimming `TResult` is the only change that saves tokens on the MCP + JSON paths; the compact renderer already drops non-displayed fields for ticket-shaped rows.
**Tech Stack:** TypeScript ESM, better-sqlite3, vitest, tsup.

---

## Ticket-scoped context

Load-bearing findings from the audit (2026-06-03) — these justify the trims and bound the scope:

- **Compact (CLI default) already trims ticket rows to 6 columns** (`id, status, priority, type, effort, title` — `format.ts:30-37`). `isTicketRow` (`format.ts:72`) requires *all six* present, else the result falls to `compactObject` key=value lines. So a full 13-field write-tool return costs extra tokens **only on the JSON path and the MCP path** (`server.ts:76` always `JSON.stringify`s the full `TResult`). The trim target is therefore the `TResult` shape itself.
- **`--verbose` is a reserved global CLI flag**, stripped from argv *anywhere* before command parsing (`index.ts:96-98`). A per-tool `verbose` arg would be silently swallowed and never reach the handler. The opt-in-full flag MUST be named **`full`** (CLI `--full`).
- **`add_many` already returns the lean shape** (`{ created: string[], count, warnings? }` — `add_many.ts:53`). `add` returning a full 13-field row is the asymmetry to fix; consistency with `add_many` is a design goal.
- **Token-budget tests measure `Buffer.byteLength(JSON.stringify(result),"utf8")` against `<N*4`** (bytes, not tokens). They exist for: `get` (<8000), `related` (<4000), `validate` (<2000), `search` (<4000), `changed_since` (<4000). **No budget test exists for `list`, `add`, `update`, `next`, `stats`.**
- Test fixtures are inline per-test (temp DB via `openDb`, project `proj1`); no shared fixture file. Tighten/extend budgets inline in each tool's `*.test.ts`.

### Field classification → decision (the audit, condensed; Task 1 expands to the doc)

| Tool | Current return | Classification | Decision |
|---|---|---|---|
| `add` | full 13-field `{ ticket }` | only `id` (+ server defaults `status`,`created_at`) is new; rest echo/derivable (`closed_at` always null on create) | **TRIM** → lean default `{ id, status, created_at }`; `full:true` → full row |
| `update` | full 13-field `{ ticket, audit_entries }` | new = which fields changed + trigger-driven `closed_at`; rest echo | **TRIM** → lean default `{ id, changed: string[], closed_at?, audit_entries }`; `full:true` → full row |
| `set_parent` | `{ ticket(full), changed }` | new = `changed`; row echoes | **TRIM** → `{ id, parent_id, changed }`; `full:true` → full row |
| `append_to_description` | full 13-field `{ ticket }` | new = resulting description; rest echo | **TRIM** → `{ id, description }`; `full:true` → full row |
| `get` | full row + tags + relations + `recent_audit[≤10]` | audit rarely needed on a read; relations usually wanted | **GATE** `recent_audit` behind `include_audit:false`; relations stay default-on |
| `next` | 10-field row + reason | READ tool; the row *is* the answer | **NO CHANGE** |
| `list` | rows (description gated by `include_description`) | already lean by default | **NO CHANGE to shape**; add a budget test (gap) |
| `stats` | 5 `by_*` maps + totals | all computed aggregate; no echo | **NO CHANGE** (record won't-do) |
| `search`,`related`,`blockers_of`,`children_of`,`changed_since`,`validate` | bounded item lists | already lean; budgets enforced | **NO CHANGE** |
| `add_many`,`import_json` `warnings[]` | load-bearing on failure | dropping loses failure detail | **NO CHANGE** (record won't-do) |
| `link`,`unlink`,`add_tag`,`remove_tag`,`register_project`,`ping`,`export` | metadata only | already minimal | **NO CHANGE** |

---

## Task 1: Findings doc (T20 AC #1)

**Files:**
- Create: `.ai/2026-06-03-T20-response-shape-findings.md`

**Decisions:**
- The doc is the auditable record AC #1 requires: one entry per tool (all 23), each classifying returned fields as **(a) new info / (b) echo of input / (c) derivable**, then a recommendation: **TRIM / GATE / NO-CHANGE**, with a one-line risk note.
- Every NO-CHANGE that *could* have been trimmed (`stats`, `next`, `add_many`/`import_json` warnings) is recorded as an explicit **won't-do with reason** — not silently omitted (AC requirement).
- Use the classification table above as the source; expand each row to new/echo/derivable + risk.

**Implement:** Transcribe and expand the condensed audit table into a per-tool findings doc; for each TRIM/GATE tool, state the exact default shape and the `full`/`include_audit` opt-in shape.

**Verify:** Doc exists; contains an entry for all 23 registered tools (cross-check against `registry.ts`); every TRIM/GATE entry names both the lean default shape and the opt-in-full shape; every plausible-but-rejected trim has a stated reason.

---

## Task 2: Lean write-tool returns with opt-in `full`

**Files:**
- Modify: `src/tools/add.ts` (`AddResult`, `inputSchema`, `parseArgs`, `handle`)
- Modify: `src/tools/update.ts` (`UpdateResult`, schema, parse, handle)
- Modify: `src/tools/set_parent.ts`
- Modify: `src/tools/append_to_description.ts`
- Modify: their `*.test.ts` siblings

**Decisions:**
- Add `full?: boolean` (default `false`) to each tool's `inputSchema` (`{ type: "boolean" }`) and `parseArgs`. When `full` is true, return today's full-row shape **unchanged** (back-compat + key-data reachability). When false, return the lean shape from the table.
- `update` lean shape must still surface **trigger-driven** state the caller didn't send: include `closed_at` whenever the `tickets_closed_at_*` trigger set/cleared it (i.e. when `status` was among the changed fields). Keep `audit_entries`. `changed` = the list of field names that actually changed.
- Lean shapes are **flat objects** (not `{ ticket: {...} }`). Rationale: a partial object under a `ticket` key is neither a full ticket row (fails `isTicketRow`) nor a clean key=value map; a flat object renders as tidy `key=value` compact lines and is smallest in JSON.

**Don't:**
- **Do NOT name the flag `verbose`** — `--verbose` is a global CLI flag stripped at `index.ts:96-98` and would never reach the handler. Use `full`.
- Do NOT change the full-row shape returned under `full:true` — downstream callers and the `full` path depend on it being today's exact 13-field row.
- Do NOT drop `audit_entries` from `update` — it is genuinely new info.
- Do NOT alter `add_many` — it is already lean and is the shape this task mirrors.

**Implement:** Add a `full` boolean arg to each write tool; branch `handle`'s return between the full row (when `full`) and the lean flat shape (default); update unit tests to assert both branches.

**Verify (TDD):** For each tool, a test asserting (1) default return contains only the lean keys and omits `description`/`title`/`project_id`/etc.; (2) `full:true` returns the unchanged 13-field row; (3) `update` lean return includes `closed_at` when a status→done transition fired the trigger. All existing behavioural assertions for these tools updated to the new default and green.

---

## Task 3: `get` — gate `recent_audit` behind `include_audit`

**Files:**
- Modify: `src/tools/get.ts` (`GetArgs`, `GetResult`/`TicketFull`, schema, parse, handle)
- Modify: `src/tools/get.test.ts`

**Decisions:**
- Add `include_audit?: boolean` (default `false`). When false, omit the `recent_audit` field entirely from each returned ticket (omit the key, don't return `[]` — fewer tokens and a clearer "ask for it" signal). When true, return today's `recent_audit` (≤10) unchanged.
- **Relations stay default-on** — they are the common reason to `get` a single ticket in depth, and the 8000-byte budget accommodates them. Record this choice in the findings doc.

**Don't:**
- Do NOT gate `tags` or `relations` — only `recent_audit`. Narrow the change to the heaviest rarely-needed payload.

**Implement:** Add `include_audit` arg; omit `recent_audit` from the result unless set; keep the multi-ticket (`ids`) path consistent.

**Verify (TDD):** Test that default `get` omits `recent_audit`; `include_audit:true` returns it; multi-id path honours the flag uniformly.

---

## Task 4: Token-budget tests — tighten changed, add for gaps

**Files:**
- Modify: `src/tools/get.test.ts` (tighten the `<8000` budget to the leaner audit-free default)
- Modify: `src/tools/add.test.ts`, `src/tools/update.test.ts` (add budget assertions for the new lean default)
- Modify: `src/tools/list.test.ts` (add a budget assertion — closes the documented gap)

**Decisions:**
- Follow the existing pattern exactly: `Buffer.byteLength(JSON.stringify(result),"utf8") < N*4`. Pick `N` from a measured default-shape size on the seeded fixture, set just above it so the budget is meaningful but not flaky.
- `get`: re-measure the default (audit-free) result and tighten `N` below today's 2000; never above. The `include_audit:true` path keeps the old looser ceiling.
- `list`: budget the default multi-row list (no `include_description`) at the common page size — the most frequent multi-row call currently has no guard.

**Don't:**
- Do NOT loosen any existing budget (`related`/`validate`/`search`/`changed_since` stay as-is and green).

**Implement:** Add/tighten byte-budget assertions per the table; record the measured before/after byte deltas in the findings doc (AC: "measured token deltas per changed tool").

**Verify:** `npm test` green; the new/tightened budgets fail if a future change re-inflates the default shape (sanity-check by temporarily reverting one trim → test goes red).

---

## Task 5: Propagate new defaults to docs, slash commands, and the skill

**Files:**
- Modify: `README.md` tool-reference table (note `full` on write tools, `include_audit` on `get`; the table claims "23 tools as of T21" — update the lean-default note)
- Modify: `docs/usage.md` (any example asserting a full-row add/update return)
- Inspect, modify if needed: `skills/ticketgraph/SKILL.md`, bundled slash commands (`/ticketgraph:tickets-add|status|next|open|done`)
- Inspect: `docs/specs/2026-05-28-ticketgraph-design.md` §6 tool contracts + §16 budgets — add a T20 note recording the tightened defaults (mirror the in-scope-reversal note style used for T21/T22–T26)

**Decisions:**
- The bundled skill and slash commands teach Claude the response shapes; if any rely on the full-row add/update return, update them to the lean shape + mention `--full`.

**Don't:**
- Do NOT rewrite the spec's history; append a dated T20 note in the established style, leaving prior decisions intact.

**Implement:** Update the docs/skill/commands that reference the changed return shapes; add the new flags to the tool-reference table.

**Verify:** `grep` the docs/skill/commands for full-row return assumptions (`created_by`, `closed_at`, 13-field examples on add/update) → none remain stale; `npm run build && npm test` green; `node dist/server.js add --help` and `get --help` show the new flags (help is schema-derived, so this is automatic once the schema gains `full`/`include_audit`).

---

## Caveats & known risks

- **Back-compat:** any existing automation parsing `add`/`update`'s full row breaks on the new lean default. Mitigation: `full:true` restores the exact old shape; call it out in the spec note. Single-user tool, so blast radius is this repo's own slash commands/skill (covered by Task 5).
- **Compact rendering shift:** trimmed write results stop being `isTicketRow` and render as `key=value` lines instead of a 6-col row. This is leaner and acceptable; Task 2 tests assert the new compact output is sane.
- **Budget `N` flakiness:** set thresholds from a measured size with a small margin; don't pin to the exact byte count.
- **Scope discipline:** `stats`, `next`, `add_many`/`import_json` warnings are deliberately untouched — each recorded as won't-do in the findings doc, not silently skipped.

---

## Review record

**Reviewed:** 2026-06-03
**Reviewer:** Claude (Opus subagent, fresh context) + two-stage spec/quality review per task
**Branch:** main (all T20 work uncommitted in working tree at review time)
**Commit:** b4e1368 (base; T20 not yet committed)

### Verification Results
- **Tests:** 643 passed / 643 (55 files), exit 0
- **Typecheck:** `tsc --noEmit` clean
- **Build:** `npm run build` success

### Triage Summary
| # | Finding | Type | Decision |
|---|---|---|---|
| 1 | All 5 tasks built exactly as planned (lean `add`/`update`/`set_parent`/`append` defaults + `full` opt-in; `get` `include_audit` gate; budgets tightened+added; docs propagated) | Completed as planned | — |
| 2 | `update` lean shape surfaces `closed_at` only when `status` changed (non-uniform but correct — only a status change can fire the trigger; type-modelled `closed_at?`, tested present/absent/null-on-reopen) | Deviation (design) | **Approved — accept as-built** |
| 3 | Plan referenced spec "§16" for token budgets, but budgets live in **§10** (§16 is testing strategy). Note correctly landed in §10 + §6. | Deviation (plan mis-reference) | **Approved** |
| 4 | `set_parent` + `append_to_description` budget tests were "optional" in the plan; added anyway (`<13×4`, `<16×4`). | Unplanned addition (endorsed) | **Approved** |
| 5 | Flag named `full` not `verbose` (verbose is stripped globally at `index.ts:96-98`). | Completed as planned | — |

### Technical Context & Learnings (permanent record)
1. **`closed_at` is fully trigger-managed** (`tickets_closed_at_set`/`_clear`, both `AFTER UPDATE OF status`, `001_init.sql:101-110`). It can only move on a status transition, so gating the lean `update` return's `closed_at` on `changed.includes("status")` is the necessary-and-sufficient predicate.
2. **Token cost is path-dependent.** Extra ticket fields are free on the CLI *compact* path (only 6 columns rendered, `format.ts:30-37`) but billed in full on the MCP and `--format json` paths (`server.ts:76` `JSON.stringify`s the whole `TResult`). Trimming the `handle()` return type is the only lever for the JSON/MCP paths.
3. **`--verbose` is stripped from argv globally** before command parsing (`index.ts:96-98`); per-tool opt-in flags must avoid that name — hence `full`.
4. **Omitting a key beats returning `[]`/`null`** — leaner and a clearer "ask for it" signal. `"key" in obj` is the right assertion to prove omission vs. empty.
5. **Union return types ripple into test helpers** — shared `addTicket` helpers that read `.ticket.*` must opt into `full:true` to keep compiling; minimal-diff fix.

### Measured impact
Default-shape byte reductions on seeded fixtures: `add` −73%, `update` −68%, `set_parent` −84%, `append_to_description` −80%, `get` (default) −76%. No data unrecoverable — every trimmed field reachable via `full:true` / `include_audit:true`.

### Items Requiring Rework
None.

### Deferred/Skipped Items
None. Deliberate won't-do (recorded in findings doc): `stats`, `next` row, `add_many`/`import_json` `warnings[]`.
