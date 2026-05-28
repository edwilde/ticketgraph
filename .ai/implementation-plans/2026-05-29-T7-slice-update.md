# T7-slice — `tickets.update` for completing tickets

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Ship the minimum write tool needed for MVP — `tickets.update({ project?, id, patch })` — so users can mark tickets `done` (or change any field) with full audit logging. Defer the rest of T7 (link/unlink/set_parent/tags/append_to_description) to post-MVP.
**Architecture:** New tool `src/tools/update.ts` following the established `Tool<TArgs, TResult>` factory pattern. One row → one DB transaction. Each changed field appends to `audit_log` via the existing `writeAudit` helper. Server registers it via the existing `makeToolRegistry`.
**Tech Stack:** TypeScript ESM, better-sqlite3. No new deps.

---

## Ticket-scoped context

- **Scope is the MVP slice only.** This plan covers `tickets.update`. It does NOT cover `tickets.append_to_description`, `tickets.link`, `tickets.unlink`, `tickets.set_parent`, `tickets.add_tag`, `tickets.remove_tag`. Those land when the full T7 ticket is reopened.
- **The MVP use case driving this slice:** the user calls `tickets.update({ id: "T5", patch: { status: "done" } })` to mark a ticket completed. The `closed_at` trigger from T4 fires automatically; the audit log captures the status flip; everything else stays untouched.
- **Patch shape:** every editable column on `tickets` is patchable EXCEPT `id`, `project_id`, `created_at`, `closed_at`. `closed_at` is trigger-managed (spec §5); `created_at` is immutable history; `id`/`project_id` are the PK. Anything else (`title`, `description`, `status`, `priority`, `type`, `effort`, `epic`, `parent_id`, `created_by`) is fair game.
- **Audit row per changed field**, not per call. Setting `{ status: "done", priority: "P0" }` writes TWO rows. Field unchanged → no row.
- **Description overwrites** via update write the FULL new value to `new_value` (spec §5 note on row shapes). Spec calls out "accept the bloat; rare relative to appends" — appends are a separate tool (deferred).
- **`parent_id` cycle detection** is in this slice. The spec calls it out under T7's full scope: "Cycle detection: rejects if it would create a cycle." Setting parent_id is a likely use case in the MVP (e.g. promoting child tickets), so include it. Cycle detection algorithm: walk `parent_id` chain from the proposed new parent upward; if you ever see the ticket-being-updated, reject.
- **`tickets.set_parent` is NOT shipped** as a separate tool in this slice. The `update({ patch: { parent_id: ... } })` path covers it.
- **Reading the current row before update**: we need the old values to write into `audit_log.old_value`. One SELECT before the UPDATE, plus a comparison loop.
- **Transaction boundary**: SELECT old → UPDATE → audit rows. All inside one `db.transaction()()`. If any audit insert fails, the whole thing rolls back.
- **`updated_at` does NOT exist on tickets** per schema spec §5. Don't add it; the audit_log is the source of truth.
- **Project param semantics**: standard `requireProject({ allowAll: false })`. No cross-project updates.
- **Validation parallels add.ts**: status / priority / type / effort all get the same parseArgs-level validation; the DB CHECK on effort catches anything that slips. Map SQLite constraint errors to `McpError(InvalidParams, ...)` exactly as in add.ts.

---

## Task 1: `src/tools/update.ts`

**Files:**
- Create: `src/tools/update.ts`

**Decisions:**
- Factory: `makeUpdateTool(db: Database.Database)` returns `Tool<UpdateArgs, UpdateResult>`.
- Args:
  ```
  type UpdateArgs = {
    project?: string;
    id: string;
    patch: {
      title?: string;
      description?: string;
      status?: TicketStatus;
      priority?: TicketPriority | null;
      type?: TicketType;
      effort?: TicketEffort | null;
      epic?: string | null;
      parent_id?: string | null;
      created_by?: string;
    };
  };
  type UpdateResult = { ticket: TicketRow; audit_entries: number };
  ```
- `parseArgs` validates:
  - `id` is a non-empty string.
  - `patch` is an object with at least one key.
  - Every supplied patch field's type matches the union (delegate to enum guards: `isStatus`, `isPriority`, `isType`, `isEffort`).
  - Keys NOT in the allowed set (`id`, `project_id`, `created_at`, `closed_at`, or anything else) → `McpError(InvalidParams, "Field '<key>' is not patchable")`.
- `handle`:
  1. Resolve project via `requireProject(db, args, process.cwd(), { allowAll: false })`.
  2. SELECT the current row. If missing → `McpError(InvalidParams, "Ticket <project>/<id> not found")`.
  3. Compute diff: build `changes: Array<{ field, old, new }>` for every patch key whose value differs from the current.
  4. If `changes.length === 0` → no-op; return the unchanged ticket + `audit_entries: 0` without opening a transaction.
  5. If `parent_id` is being changed, run cycle detection (Task 2 helper).
  6. Inside one `db.transaction()()`:
     a. Build dynamic `UPDATE tickets SET col = ?, ... WHERE project_id = ? AND id = ?` with the patch fields. Parameterised, never interpolated.
     b. For each change, `writeAudit(db, { projectId, ticketId, field, oldValue, newValue, changedAt })` — single timestamp for all rows in the batch.
     c. Map SQLite errors: `SQLITE_CONSTRAINT_CHECK` (effort) → InvalidParams; `SQLITE_CONSTRAINT_FOREIGNKEY` (parent_id pointing at a non-existent ticket) → InvalidParams; PRIMARYKEY/UNIQUE shouldn't fire for updates of these columns, but guard anyway.
  7. Re-SELECT and return `{ ticket: <fresh row>, audit_entries: changes.length }`. *Because* `closed_at` may have flipped via the trigger; the caller needs the post-update state.

**Don't:**
- Don't return the prior state — caller already had it or can query audit_log.
- Don't touch FTS triggers — they fire automatically on `title`/`description` updates.
- Don't allow patching `id` or `project_id` even via undocumented keys — the parseArgs whitelist must reject them.
- Don't write audit rows outside the transaction.
- Don't issue separate UPDATEs per field — single statement.

**Implement:** Tool factory + parseArgs validator + handle.

**Verify:** Unit tests in Task 3.

---

## Task 2: `parent_id` cycle detection helper

**Files:**
- Create or expand: `src/lib/cycles.ts` + tests `src/lib/cycles.test.ts`

**Decisions:**
- Function: `wouldCreateCycle(db, { projectId, ticketId, newParentId }): boolean`.
- Algorithm: walk `parent_id` from `newParentId` upward (`SELECT parent_id FROM tickets WHERE project_id = ? AND id = ?`). At each step, if the next id equals `ticketId`, return true. If `parent_id` becomes null, return false. Hard cap at 100 hops as a safety net (a malformed DB with a pre-existing cycle would loop forever otherwise).
- Tests:
  - No existing parent chain → false.
  - Linear chain (A→B→C, set C's parent to A) → false (A is above C, no cycle).
  - Direct self-loop attempt (set A's parent to A) → true.
  - Two-step loop attempt (A→B, set B's parent to A; new parent chain would be B→A→B) → true.
  - Deep chain (10 levels) → linear time.
  - Hard cap triggers and throws if the DB already has a cycle (defensive — should never happen in practice).

**Don't:**
- Don't reach into `update.ts` from `cycles.ts` — keep the helper a pure DB-walking utility.
- Don't load the entire tickets table — walk lazily.

**Implement:** Helper + tests.

**Verify:** `npm test src/lib/cycles.test.ts` → all passing.

---

## Task 3: Unit tests for `tickets.update`

**Files:**
- Create: `src/tools/update.test.ts`

**Decisions:**
- Test cases (one `it` per row below):
  1. **Basic mark-as-done.** Insert open ticket; update `{ status: "done" }`; assert row's status=done; assert `closed_at` is set; assert exactly 1 audit row (`field='status', old='open', new='done'`).
  2. **Mark-as-deferred sets closed_at.** Same as above for `deferred`.
  3. **Re-open clears closed_at.** Insert done ticket via two-step flow (open → done); then update status:open; assert closed_at is NULL; assert 2 status audit rows total.
  4. **Multi-field patch writes one audit row per changed field.** Update `{ status: "in_progress", priority: "P0" }`; assert 2 audit rows with the same `changed_at`.
  5. **No-op patch (same value).** Insert open ticket; update `{ status: "open" }`; assert 0 audit rows; return `audit_entries: 0`.
  6. **Description overwrite stores full new value.** Update `{ description: "new body" }`; assert audit row's `new_value` equals the full new description.
  7. **Effort CHECK violation maps to InvalidParams.** Update `{ effort: 4 }` → throws `McpError`.
  8. **Patching a non-existent ticket → InvalidParams.**
  9. **Patching a non-existent project → InvalidParams.**
  10. **Patching disallowed fields → InvalidParams.** Try `{ id: "T9" }`, `{ project_id: "other" }`, `{ created_at: "..." }`, `{ closed_at: "..." }` — each must throw at parseArgs.
  11. **`parent_id: null` clears the parent.** Sets parent then clears it; audit row shows `old_value=<parent>, new_value=NULL`.
  12. **`parent_id` cycle rejection.** Set up A → B (B is parent of A). Try to update B's parent_id to A → rejected with InvalidParams referencing the cycle.
  13. **`parent_id` to non-existent ticket → InvalidParams** (FK violation maps cleanly).
  14. **Patch with no fields → InvalidParams** (empty patch object).

**Don't:**
- Don't share DBs across tests.
- Don't rely on Date.now() — use stable ISO timestamps for input data so audit row inspection is deterministic.

**Implement:** Test file with the 14 cases above.

**Verify:** All passing.

---

## Task 4: Wire into the server registry + E2E

**Files:**
- Modify: `src/server.ts` — add `updateTool` to `makeToolRegistry`.
- Modify: `tests/server.tools.test.ts` — extend the 7-step flow with a "mark T1 done" step.

**Decisions:**
- Registry import: `import { makeUpdateTool } from "./tools/update.js"` + register entry.
- E2E extension: after `tickets.add` creates T1, call `tickets.update { id: "T1", patch: { status: "done" } }`, then `tickets.get { id: "T1" }` and assert `status: "done"` + `closed_at` is set.

**Don't:**
- Don't break the existing test flow — add the step, don't restructure.

**Implement:** Registry add + test extension.

**Verify:** `npm test tests/server.tools.test.ts` passes; `tools/list` returns 7 tools.

---

## Task 5: Full acceptance gate

**Files:** (none — verification only)

**Decisions:**
- MVP exit criteria:
  - User can call `tickets.register_project` to register a project.
  - User can call `tickets.add` to create a ticket.
  - User can call `tickets.list` / `tickets.get` / `tickets.stats` to read tickets.
  - User can call `tickets.update { patch: { status: "done" } }` to mark a ticket completed.
  - Token budgets satisfied by existing tests.
  - All audit-log writes happen inside their owning transaction.

**Verify:**
1. `npm run build` → exit 0.
2. `npm test` → exit 0; all tests green.
3. `npm run typecheck` → exit 0.
4. `node dist/server.js --help` → exit 0; regression check.
5. `grep -rn 'console\.' src/ tests/` → 0 hits.
6. E2E test exercises the full MVP flow including mark-done.

---

## Caveats & known risks

- **Field-by-field audit logging vs. row-level.** Update writes one audit row per changed field. `changed_since` in T8 can then filter `WHERE field = 'status'` cleanly. Don't optimise this away by writing a single "row-changed" audit entry.
- **Effort patch can violate CHECK.** The DB catches it; map the error message friendly: `"effort must be one of 1, 2, 3, 5, 8, 13 or NULL"`.
- **Status patch is not enum-checked at DB level** (spec §5 leaves it to app code). Validate in `parseArgs`. Allowed values: `open`, `in_progress`, `blocked`, `done`, `deferred`.
- **`parent_id` to a ticket in another project**: FK is composite `(project_id, parent_id)` → won't resolve, FK violation. Maps to InvalidParams; the user gets "parent_id <id> not found in project <project>".
- **Title/description updates trigger FTS sync** automatically. Tests in T4 already cover this — no new FTS work here.
- **Concurrency:** WAL + `BEGIN IMMEDIATE` mean if two updates race, one will get `SQLITE_BUSY`. Acceptable for v1 (spec §13); map to a clear error.
- **`closed_at` trigger interactions with `parent_id`:** unrelated. The trigger only fires on `UPDATE OF status`. Tested already.

---

## Validation review

(none — small, well-scoped slice; cycle detection is the only novel logic and the helper is fully testable.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier subagent, fresh context)
**Branch:** main (slice unstaged at review time)

### Verification Results
- `npm run build` → exit 0; `dist/server.js` 43.98 KB.
- `npm test` → exit 0; **136/136 tests** across 20 files (was 116/18 before this slice).
- `npm run typecheck` → exit 0.
- `node dist/server.js --help` → exit 0.
- `grep -rn 'console\.' src/ tests/` → 0 hits.
- Live MVP smoke test via Python MCP stdio driver: register → add(T1) → list → update(done) → get → stats — full round-trip works with `closed_at` set by trigger.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | All 16 acceptance criteria | Completed as planned | — |
| 2 | DB-level CHECK constraint for effort not independently tested (parseArgs catches it first) | Suggested (test) | Deferred — defence-in-depth; mapping code exists and is exercised by the general constraint catch |
| 3 | `created_by` patch accepts empty string | Nit | Deferred — consistent with `add.ts`; spec is silent |

### Technical Context & Learnings
- **`tickets.update` is the single write tool for the MVP.** It handles status flips, description rewrites, parent reparenting, and every other field change. Per-field audit rows with a shared `changed_at` make `tickets.changed_since` (T8) trivially queryable.
- **Cycle detection in `src/lib/cycles.ts`** walks the parent_id chain lazily with a 100-hop hard cap. Pre-existing cycles in a malformed DB throw; new cycles being introduced via update reject cleanly with InvalidParams.
- **`closed_at` flips via trigger** — the update path doesn't touch it directly. The post-update re-SELECT captures the trigger-modified value so callers see the right state.
- **SQL parameterisation in dynamic UPDATE**: field names come from a hardcoded whitelist (`PATCHABLE_FIELDS`); values are always `?` placeholders bound at execute time. No user input ever string-interpolates into SQL.
- **MVP loop verified end-to-end**: register_project → add → list/get → update(status:done) → closed_at automatically set → stats reflects the new status. This is the ticketgraph plugin's minimum viable surface.

### Items Requiring Rework
None.

### Deferred/Skipped Items (intentional — full T7 still open)
- `tickets.append_to_description` (text-append-with-audit pattern).
- `tickets.link` / `tickets.unlink` (typed-relation CRUD).
- `tickets.set_parent` standalone tool (covered by `update`).
- `tickets.add_tag` / `tickets.remove_tag` (tag CRUD).
- Direct DB-level effort CHECK test (parseArgs covers the path).

### MVP Completion Note
With this slice merged, ticketgraph reaches its stated MVP:
- ✅ Add tickets (`tickets.add`)
- ✅ Read tickets, including outstanding (`tickets.list` / `tickets.get` / `tickets.stats` with the default status filter)
- ✅ Mark tickets completed (`tickets.update { patch: { status: "done" } }` — `closed_at` set by trigger)
- Plus: project registration, search-ready FTS5 schema (T6 to expose), audit log of every change.
