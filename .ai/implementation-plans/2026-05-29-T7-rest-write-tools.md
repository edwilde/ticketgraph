# T7-rest — link / unlink / set_parent / append_to_description / add_tag / remove_tag

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Complete the T7 write-tool surface: typed-relation CRUD (`link`/`unlink`), umbrella hierarchy (`set_parent`), description appends (`append_to_description`), and tag CRUD (`add_tag`/`remove_tag`). Every write is audit-logged with the exact row shapes from spec §5.
**Architecture:** Six new `Tool<TArgs, TResult>` factories in `src/tools/`, each following the established `makeXxxTool(db)` pattern. Reuse `requireProject` (cwd resolution), `writeAudit` (audit rows), `wouldCreateCycle` (for set_parent), and the `nowIso` timestamp helper. Register all six in `makeToolRegistry`. Extend the stdio E2E test.
**Tech Stack:** TypeScript ESM, better-sqlite3. No new deps.

---

## Ticket-scoped context

- **The MVP slice (`tickets.update`) already shipped** with cycle detection in `src/lib/cycles.ts` and the factory pattern. This ticket adds the remaining T7 tools. `tickets.update` is NOT changed.
- **Audit row shapes are spec §5, verbatim** — get these exactly right; T8's `changed_since` queries them by `field`:
  - Relation add: `field='relation:<kind>'`, `old_value=NULL`, `new_value='<from>-><to>'`.
  - Relation remove: `field='relation:<kind>'`, `old_value='<from>-><to>'`, `new_value=NULL`.
  - Tag add: `field='tag'`, `old_value=NULL`, `new_value=<normalised-tag>`.
  - Tag remove: `field='tag'`, `old_value=<normalised-tag>`, `new_value=NULL`.
  - `description` append: `field='description:append'`, `new_value=<appended text only>` (NOT the full description), `old_value=NULL`.
  - `parent_id` change: `field='parent_id'`, `old_value=<old-or-NULL>`, `new_value=<new-or-NULL>`.
- **Known relation kinds** (spec §5): `blocks`, `follows_up`, `supersedes`, `relates_to`. Validation lives in *code*, not a DB CHECK. `tickets.link({ force: true })` admits an unknown kind without erroring.
- **Relation direction is canonical** (spec §5): `from` is the active party. `from blocks to` → `from` blocks `to`. Store exactly as given; never auto-add a reverse edge (even for `relates_to`, which is symmetric — `tickets.related` surfaces it from both ends at read time).
- **`relations` PK is `(project_id, from_id, to_id, kind)`** — a duplicate link is a PK collision. `link` should be idempotent-friendly: catch the PK violation and return a clear "relation already exists" — OR treat re-link as a no-op success. **Decision:** error with `McpError(InvalidParams, "Relation <from>-<kind>-><to> already exists.")` — explicit is better; the caller can unlink first.
- **Both ids must exist in the same project** before linking. The FK enforces it at DB level (CASCADE), but validate in code first for a friendlier error than a raw FK failure.
- **`set_parent` overlaps with `update`'s parent_id path.** Ship it anyway for discoverability (spec §6 lists it as a named tool) and have it reuse `wouldCreateCycle`. Keep the audit row shape identical to update's parent_id change so history is consistent regardless of which tool was used.
- **Tag normalisation** (spec §5): `tag.trim().toLowerCase()` on every tag in/out. `add_tag` on an already-present tag → PK collision; treat as a no-op success (tags are a set; adding twice is harmless) OR error. **Decision:** no-op success returning the current tag list — adding an existing tag isn't a user error.
- **`append_to_description`**: append `text` to the existing description with `separator` (default `"\n\n"`). If the description is currently empty, do NOT prepend the separator (no leading blank). Write the FTS-syncing UPDATE (the `tickets_fts_au` trigger fires on description change automatically). Audit stores only the appended chunk.
- **All writes are transactional**: the mutation + its audit row(s) in one `db.transaction()()`. A failed audit insert rolls back the mutation.
- **Project param**: standard `requireProject(db, { project }, process.cwd())` with `allowAll: false` for all six (these are single-project writes).
- **`McpError` mapping**: validation failures and SQLite constraint errors → `McpError(InvalidParams, ...)`, consistent with `add.ts`/`update.ts`.

---

## Task 1: `tickets.link` + `tickets.unlink`

**Files:**
- Create: `src/tools/link.ts` + `src/tools/link.test.ts`
- Create: `src/tools/unlink.ts` + `src/tools/unlink.test.ts`
- Create: `src/lib/relations.ts` + `src/lib/relations.test.ts` (shared: `KNOWN_RELATION_KINDS`, `isKnownKind`, an `assertTicketExists` helper)

**Decisions:**
- `src/lib/relations.ts` exports `KNOWN_RELATION_KINDS = ["blocks", "follows_up", "supersedes", "relates_to"] as const` and a type `RelationKind`. Also `ticketExists(db, projectId, id): boolean`.
- `link` args: `{ project?, from: string, to: string, kind: string, note?: string, force?: boolean }`.
  - parseArgs: from/to/kind non-empty strings; note optional string; force optional boolean.
  - handle: resolve project; if `!force && !isKnownKind(kind)` → `McpError(InvalidParams, "Unknown relation kind '<kind>'. Known: blocks, follows_up, supersedes, relates_to. Pass force: true to use anyway.")`. Reject `from === to` (a ticket can't relate to itself) → InvalidParams. Validate both tickets exist. Insert relation with `created_at = nowIso()`. Catch PK collision → "already exists" error. Write audit `field='relation:<kind>'`, `new_value='<from>-><to>'`.
  - Return `{ from, to, kind, note: note ?? null, created_at }`.
- `unlink` args: `{ project?, from, to, kind }`.
  - handle: resolve project; DELETE the matching row. If `changes === 0` → `McpError(InvalidParams, "No <kind> relation <from>-><to> to remove.")`. Write audit `field='relation:<kind>'`, `old_value='<from>-><to>'`, `new_value=NULL`.
  - Return `{ removed: true }`.

**Don't:**
- Don't auto-create reverse edges for `relates_to`.
- Don't allow self-relations (`from === to`).
- Don't write the audit row outside the transaction.
- Don't validate `kind` against a DB CHECK — code-level only (spec §5).

**Implement:** Two tools + shared relations lib.

**Verify:** Unit tests:
- link success (known kind) → relation row exists + 1 audit row with correct shape.
- link unknown kind without force → InvalidParams.
- link unknown kind with force → succeeds.
- link with non-existent from/to → InvalidParams.
- link self-relation → InvalidParams.
- link duplicate → InvalidParams (already exists).
- unlink success → row gone + audit row (old=`<from>-><to>`, new=NULL).
- unlink non-existent → InvalidParams.

---

## Task 2: `tickets.set_parent`

**Files:**
- Create: `src/tools/set_parent.ts` + `src/tools/set_parent.test.ts`

**Decisions:**
- Args: `{ project?, id: string, parent_id: string | null }`.
- handle: resolve project; SELECT current row (must exist → else InvalidParams). Read current parent_id for the audit `old_value`.
  - If `parent_id === id` → InvalidParams ("a ticket cannot be its own parent").
  - If `parent_id` is non-null: validate it exists in the project; run `wouldCreateCycle(db, { projectId, ticketId: id, newParentId: parent_id })` → if true, InvalidParams referencing the cycle.
  - If new parent === current parent → no-op, return current ticket, 0 audit entries.
  - Transaction: UPDATE tickets SET parent_id = ?; writeAudit `field='parent_id'`, `old_value=<old>`, `new_value=<new>`.
- Return `{ ticket: <fresh row>, changed: boolean }`.

**Don't:**
- Don't duplicate the cycle-detection logic — import `wouldCreateCycle` from `src/lib/cycles.ts`.
- Don't diverge from `update`'s parent_id audit shape.

**Implement:** Tool reusing the cycle helper.

**Verify:** Unit tests:
- set parent success → parent_id set + audit row.
- clear parent (null) → parent_id NULL + audit (old=`<parent>`, new=NULL).
- self-parent → InvalidParams.
- cycle → InvalidParams.
- non-existent parent → InvalidParams.
- no-op (same parent) → 0 audit rows.

---

## Task 3: `tickets.append_to_description`

**Files:**
- Create: `src/tools/append_to_description.ts` + `src/tools/append_to_description.test.ts`

**Decisions:**
- Args: `{ project?, id: string, text: string, separator?: string }`. Default separator `"\n\n"`.
- handle: resolve project; SELECT current description (row must exist). New description = `current === "" ? text : current + separator + text`.
  - Transaction: UPDATE tickets SET description = ? (FTS trigger fires); writeAudit `field='description:append'`, `old_value=NULL`, `new_value=text` (the appended chunk only, NOT the full description).
- Return `{ ticket: <fresh row> }` (so caller sees the updated description).
- Validate `text` is a non-empty string (appending empty is a no-op error → InvalidParams "text must be non-empty").

**Don't:**
- Don't store the full description in the audit `new_value` — only the appended chunk (spec §5: cheaper for `changed_since` to scan).
- Don't prepend the separator when the description is empty.

**Implement:** Tool.

**Verify:** Unit tests:
- append to empty description → description === text, no leading separator.
- append to non-empty → description === old + "\n\n" + text.
- custom separator honoured.
- audit row new_value === appended chunk only (not full description).
- FTS reflects the appended text (MATCH on a word only in the appended chunk).
- empty text → InvalidParams.

---

## Task 4: `tickets.add_tag` + `tickets.remove_tag`

**Files:**
- Create: `src/tools/add_tag.ts` + `src/tools/add_tag.test.ts`
- Create: `src/tools/remove_tag.ts` + `src/tools/remove_tag.test.ts`

**Decisions:**
- Normalisation helper: reuse the same `normaliseTag(tag) = tag.trim().toLowerCase()` logic already used in `add.ts`. If `add.ts` has it inline, lift it to `src/lib/tags.ts` (`normaliseTag`) and have both call it. Check `add.ts` first; if inline, refactor minimally (don't change add.ts behaviour).
- `add_tag` args: `{ project?, id, tag }`.
  - handle: resolve project; ticket must exist. Normalise tag; reject empty post-normalisation → InvalidParams. Transaction: `INSERT OR IGNORE INTO tags ...`. If a row was actually inserted (`changes === 1`), writeAudit `field='tag'`, `new_value=<tag>`. If already present (`changes === 0`), skip the audit row (no-op).
  - Return `{ tags: <current full tag list, sorted> }`.
- `remove_tag` args: `{ project?, id, tag }`.
  - handle: resolve project; normalise; DELETE. If `changes === 0` → no-op (tag wasn't there); do NOT error and do NOT write audit. If `changes === 1`, writeAudit `field='tag'`, `old_value=<tag>`, `new_value=NULL`.
  - Return `{ tags: <current full tag list, sorted> }`.

**Don't:**
- Don't error on adding a duplicate tag — tags are a set; it's a no-op.
- Don't error on removing an absent tag — idempotent removal.
- Don't write an audit row for a no-op.
- Don't change `add.ts`'s existing tag behaviour when lifting the helper.

**Implement:** Two tools + (if needed) `src/lib/tags.ts`.

**Verify:** Unit tests:
- add_tag normalises ("  FTS  " → "fts") + 1 audit row.
- add_tag duplicate → no-op, no second audit row, tag list unchanged.
- remove_tag present → removed + 1 audit row.
- remove_tag absent → no-op, no audit row, no error.
- returned tag list is sorted + normalised.

---

## Task 5: Wire all six into the registry + E2E

**Files:**
- Modify: `src/server.ts` — add the six tools to `makeToolRegistry`.
- Modify: `tests/server.tools.test.ts` — extend the flow to exercise link, set_parent, append, and a tag, then `tickets.get` to confirm they surface.

**Decisions:**
- Registry now has 13 tools (7 existing + 6 new). Update the `tools/list` count assertion.
- E2E additions (append to the existing flow, don't restructure): after T1/T2 exist, `tickets.link { from: "T1", to: "T2", kind: "blocks" }`; `tickets.set_parent { id: "T2", parent_id: "T1" }`; `tickets.append_to_description { id: "T1", text: "extra note" }`; `tickets.add_tag { id: "T1", tag: "Urgent" }`; then `tickets.get { id: "T1" }` asserts the outgoing blocks relation, the appended text, and tag `urgent` (normalised).

**Don't:**
- Don't restructure the existing E2E steps — append new ones.

**Implement:** Registry + E2E extension.

**Verify:** `npm test tests/server.tools.test.ts` passes; `tools/list` returns 13 tools.

---

## Task 6: Full acceptance gate

**Files:** (none — verification only)

**Decisions:**
- Spec acceptance for T7: all tools callable, all writes audit-logged; cycle detection on set_parent test-covered; tag normalisation lowercase+trimmed.

**Verify:**
1. `npm run build` → exit 0.
2. `npm test` → exit 0; all tests green (136 prior + new ones).
3. `npm run typecheck` → exit 0.
4. `node dist/server.js --help` → exit 0.
5. `grep -rn 'console\.' src/ tests/` → 0 hits.

---

## Caveats & known risks

- **Relation kind extensibility**: `force: true` admits unknown kinds. This is deliberate (spec §5) so a future kind doesn't need a schema migration. The canonical set stays the four; `tickets.related` (T8) should still group by whatever kind is stored.
- **`set_parent` vs `update` overlap**: both write `field='parent_id'` audit rows with identical shape, so `changed_since` sees a consistent history. If they ever diverge, that's a bug.
- **Idempotency choices**: `add_tag`/`remove_tag` are idempotent (no-op on duplicate/absent). `link`/`unlink` are NOT (explicit error on duplicate/absent) — the asymmetry is intentional: tags are a set where double-add is meaningless, but a duplicate link with a different `note` is a likely mistake worth surfacing.
- **FTS sync on append**: the `tickets_fts_au` trigger fires on description UPDATE, keeping search current. Covered by an explicit test.
- **Transaction atomicity**: every mutation + audit pair is wrapped. Better-sqlite3's `db.transaction(fn)()` rolls back on any throw inside `fn`.
- **`normaliseTag` lift**: if `add.ts` inlines normalisation, lifting to `src/lib/tags.ts` must not change add.ts's output. Verify add.ts tests still pass after the refactor.

---

## Validation review

(none — six small tools following an established pattern; cycle reuse and audit shapes are the only subtlety, both well-specified.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier subagent, fresh context)
**Branch:** main (unstaged at review time)

### Verification Results
- `npm run build` → exit 0; `dist/server.js` 63.17 KB.
- `npm test` → exit 0; **175/175 tests** across 27 files (was 136/20).
- `npm run typecheck` → exit 0.
- `node dist/server.js --help` → exit 0.
- `grep -rn 'console\.' src/ tests/` → 0 hits.
- All 6 audit row shapes verified against code + a dedicated test assertion each.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | All 39 acceptance criteria (6 tools, 6 audit shapes, transactionality, registry, E2E) | Completed as planned | — |
| 2 | `remove_tag` did not validate ticket existence (asymmetric with `add_tag`) | Suggested (quality) | Fixed in-line — added `ticketExists` check + regression test; test count 174→175 |
| 3 | Stale "assert 6 tools" comment in E2E test (asserts 13 correctly) | Nit | Fixed in-line |
| 4 | `add.ts` inlines tag normalisation rather than importing `normaliseTag` from new `src/lib/tags.ts` | Suggested (quality) | Deferred — identical logic, no divergence today; out of T7 scope. Worth a future cleanup. |

### Technical Context & Learnings
- **Audit row shapes are now battle-tested** across all write tools. T8's `changed_since` can filter by `field`: `'status'`, `'parent_id'`, `'relation:<kind>'`, `'tag'`, `'description'` (overwrite), `'description:append'`, `'_created'`.
- **Idempotency asymmetry is deliberate**: tags are a set (`add_tag`/`remove_tag` are no-op on duplicate/absent), but relations carry semantics (`link`/`unlink` error on duplicate/absent) — a duplicate link with a different `note` is a likely mistake worth surfacing.
- **`relations.ts` lib** exports `KNOWN_RELATION_KINDS`, `isKnownKind`, `ticketExists` — the canonical relation-kind validation point. `force: true` admits unknown kinds without a schema change (spec §5).
- **`set_parent` and `update`** both write identical `field='parent_id'` audit rows and both reuse `wouldCreateCycle` — history is consistent regardless of entry point.
- **`tags.ts`** holds `normaliseTag` (trim+lowercase); add_tag/remove_tag use it. add.ts still inlines the same logic (deferred cleanup).
- **FTS sync on append** confirmed: `append_to_description`'s UPDATE fires `tickets_fts_au`; a MATCH on a word unique to the appended chunk returns the row.

### Items Requiring Rework
None.

### Deferred/Skipped Items
- Lift `add.ts`'s inline tag normalisation to import `normaliseTag` (single source of truth).
