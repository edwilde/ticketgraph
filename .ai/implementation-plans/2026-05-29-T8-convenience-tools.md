# T8 — Convenience tools: next / related / blockers_of / children_of / changed_since / validate

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Ship the six read-only convenience tools that turn the raw ticket store into a workflow surface: pick the next ticket, traverse relations, find blockers, walk the umbrella tree, slice the audit log, and validate integrity.
**Architecture:** Six new `Tool<TArgs, TResult>` factories in `src/tools/`. A shared `src/lib/graph.ts` holds the recursive traversal primitives (relation walk, parent walk) so `related`/`blockers_of`/`children_of` don't each reinvent BFS. All read-only — no audit writes. Register in `makeToolRegistry`.
**Tech Stack:** TypeScript ESM, better-sqlite3. No new deps.

---

## Ticket-scoped context — spec reconciliation (READ THIS)

The design spec §6 and the TICKETS.md T8 scope disagree in two places. **The design spec §6 + §5 are authoritative** (TICKETS.md is a tracker, the spec is the design of record). Decisions:

1. **`blockers_of` direction.** TICKETS.md T8 says "filtered to kind `blocks` *outgoing* direction" — this is WRONG and contradicts spec §5's direction convention. Per spec §5: "`from blocks to` → `from` is the blocker; `to` is waiting on `from`. `tickets.blockers_of(X)` therefore looks for rows with `to = X`." So **blockers_of(X) = INCOMING `blocks` edges**: relations where `to_id = X AND kind = 'blocks'`; the blocker is `from_id`. Recurse on the blocker's own blockers.
2. **Default depths.** Spec §6 table: `related` default **1** (max 3); `blockers_of` default **2** (max 3); `children_of` default **2** (max 3). TICKETS.md says children_of default 1 — follow the spec (default 2). Clamp all to max 3.

Other context:
- **`next` "unblocked" definition** (spec §6): the highest-priority `status='open'` ticket with **no incoming `blocks` edge from a non-`done`/`deferred` ticket**. A blocks-edge from an already-done blocker does NOT count (the blocker is resolved). Sort: `priority ASC NULLS LAST, created_at ASC`. Ties broken by `id ASC`. Returns `{ ticket, reason: { priority, age_days, no_open_blockers: true } }`. `age_days` = whole days between `created_at` and now. `type?` filter narrows to a ticket type. If nothing qualifies → `{ ticket: null, reason: null }` (not an error).
- **`related`** returns BOTH incoming and outgoing relations grouped by direction → kind → list of `{ id, note, depth }`. `kinds?` filters to a subset of relation kinds. `depth` recursion follows edges of the *selected kinds* outward; each surfaced node carries the depth at which it was found. Cap visited-set to avoid infinite loops on `relates_to` cycles.
- **`blockers_of`** is `related` specialised to incoming `blocks`, recursed to build the full dependency tree rooted at the ticket. Return shape: a flat list of `{ id, title, status, depth }` ordered by depth then id, plus maybe a nested form — keep it flat for token economy.
- **`children_of`** walks `parent_id` *downward* (find tickets whose `parent_id` = current, recursively). Return flat `{ id, title, status, parent_id, depth }` list.
- **`changed_since`** (spec §6): slices `audit_log` by `changed_at >= since` (ISO date or datetime). Optional `field` filter (e.g. `'status'`) and `new_value` filter. Returns compact rows `{ ticket_id, field, old_value, new_value, changed_at }` sorted `changed_at DESC`. Default `limit` 100, clamp to 500. `since` is required; validate it's a parseable ISO string.
- **`validate`** (spec §6/§5): integrity report. Checks:
  - Orphan `parent_id`: tickets whose `parent_id` points at a non-existent ticket. (FK `ON DELETE SET NULL` should prevent this, but check anyway — spec says "shouldn't happen with FKs, but check anyway".)
  - Dangling relations: relation rows whose `from_id` or `to_id` doesn't exist. (FK CASCADE should prevent; check anyway.)
  - Status invariants: tickets with `closed_at` set but `status NOT IN ('done','deferred')`; and tickets with `status IN ('done','deferred')` but `closed_at IS NULL`. (The latter is legal post-import per spec §7, so report it as `info`, not `error` — see Decisions.)
  - Return `{ project, ok: boolean, issues: [{ kind, ticket_id, detail }] }`. `ok = issues.filter(i => i.severity === 'error').length === 0`.
- **All six are read-only.** No `writeAudit`, no transactions needed (pure SELECTs).
- **Project scope:** all six use `requireProject(db, { project }, process.cwd())` with `allowAll: false` (auto-scoped to one project). Cross-project variants are a future enhancement; don't add now.
- **Token budgets** (spec §10): next <300, related <1000, blockers_of <1000, children_of <1500, changed_since <1000, validate <500. Bytes-over-4 assertions in tests.

---

## Task 1: `src/lib/graph.ts` — traversal primitives

**Files:**
- Create: `src/lib/graph.ts` + `src/lib/graph.test.ts`

**Decisions:**
- Export `walkRelations(db, { projectId, startId, kinds, direction, maxDepth }): Array<{ id, kind, note, depth, direction }>`.
  - `direction`: `"incoming"` (rows with `to_id` = current), `"outgoing"` (rows with `from_id` = current), or `"both"`.
  - BFS from `startId`; at each hop follow edges matching `kinds` (all known kinds if omitted) in the requested direction; record `depth` (1 for direct, 2 for next hop...). Stop at `maxDepth`. Maintain a `visited` set keyed by id to prevent cycles (esp. symmetric `relates_to`).
  - The start node itself is NOT in the result; only related nodes.
- Export `walkChildren(db, { projectId, parentId, maxDepth }): Array<{ id, parent_id, depth }>`.
  - BFS downward over `parent_id`. `visited` set guards against malformed cycles.
- Both are pure read helpers; they return ids + edge metadata, NOT full ticket rows. Callers join to `tickets` for title/status as needed (keeps the primitive lean).

**Don't:**
- Don't load full ticket rows inside the walk — return ids + depth; let callers select the columns they need.
- Don't recurse without a `visited` guard — `relates_to` is symmetric and WILL cycle.
- Don't exceed `maxDepth` (the tools clamp it to 3 before calling).

**Implement:** Two BFS helpers + tests.

**Verify:** Unit tests:
- walkRelations outgoing depth 1 returns direct edges only.
- walkRelations depth 2 returns the second hop with depth=2.
- walkRelations with a `relates_to` cycle terminates (visited guard).
- walkRelations `kinds` filter restricts followed edges.
- walkChildren returns descendants with correct depth.
- walkChildren on a leaf returns [].

---

## Task 2: `tickets.next`

**Files:**
- Create: `src/tools/next.ts` + `src/tools/next.test.ts`

**Decisions:**
- Args: `{ project?, type? }`.
- Query: candidate set = `status = 'open'` tickets (optionally `AND type = ?`). Exclude any candidate that has an incoming `blocks` edge from a blocker whose `status NOT IN ('done','deferred')`. SQL:
  ```sql
  SELECT t.* FROM tickets t
  WHERE t.project_id = ? AND t.status = 'open' [AND t.type = ?]
    AND NOT EXISTS (
      SELECT 1 FROM relations r JOIN tickets b
        ON b.project_id = r.project_id AND b.id = r.from_id
      WHERE r.project_id = t.project_id AND r.to_id = t.id AND r.kind = 'blocks'
        AND b.status NOT IN ('done','deferred')
    )
  ORDER BY (t.priority IS NULL), t.priority ASC, t.created_at ASC, t.id ASC
  LIMIT 1
  ```
  (`(t.priority IS NULL)` sorts non-null first = NULLS LAST.)
- Compute `age_days = floor((now - created_at) / 86400000)`.
- Return `{ ticket, reason: { priority, age_days, no_open_blockers: true } }` or `{ ticket: null, reason: null }` when empty.

**Don't:**
- Don't count a `blocks` edge from a done/deferred blocker as blocking.
- Don't return more than one ticket.
- Don't error on "nothing to do" — return nulls.

**Implement:** Tool.

**Verify:** Unit tests:
- picks highest priority (P0 before P1 before null).
- skips a ticket blocked by an open blocker.
- a ticket blocked only by a DONE blocker IS eligible.
- `type` filter narrows.
- ties broken by created_at then id.
- empty/all-blocked → `{ ticket: null }`.
- token budget <300×4 bytes.

---

## Task 3: `tickets.related`

**Files:**
- Create: `src/tools/related.ts` + `src/tools/related.test.ts`

**Decisions:**
- Args: `{ project?, id, kinds?, depth? }`. Default depth 1, clamp 1–3.
- Use `walkRelations(direction: "both")`. Group results: `{ outgoing: { <kind>: [{ id, note, depth }] }, incoming: { <kind>: [...] } }`.
- Validate the ticket exists → else InvalidParams.
- Optionally enrich each related id with `title`/`status` (one batched SELECT) — keeps the response useful without a follow-up `get`. Budget allows it (<1000 tokens).

**Don't:**
- Don't recurse beyond clamped depth.
- Don't dedupe across kinds — a pair could be linked by two kinds; show both.

**Implement:** Tool over the graph primitive.

**Verify:** Unit tests:
- direct in+out relations grouped by direction/kind.
- depth 2 surfaces second-hop with depth=2.
- `kinds` filter.
- non-existent id → InvalidParams.
- token budget <1000×4.

---

## Task 4: `tickets.blockers_of` + `tickets.children_of`

**Files:**
- Create: `src/tools/blockers_of.ts` + `.test.ts`
- Create: `src/tools/children_of.ts` + `.test.ts`

**Decisions:**
- `blockers_of` args: `{ project?, id, depth? }`. Default depth 2, clamp 1–3. = `walkRelations(direction: "incoming", kinds: ["blocks"])`. Enrich with title/status. Return flat `{ blockers: [{ id, title, status, depth }] }` ordered by depth, id.
- `children_of` args: `{ project?, id, depth? }`. Default depth 2, clamp 1–3. = `walkChildren`. Enrich with title/status. Return `{ children: [{ id, title, status, parent_id, depth }] }` ordered by depth, id.
- Both validate the root ticket exists.

**Don't:**
- Don't follow `blocks` outgoing for blockers_of (that's "what this blocks", the opposite question).
- Don't include the root ticket in its own results.

**Implement:** Two thin tools over the primitives.

**Verify:** Unit tests:
- blockers_of returns incoming blocks chain to depth.
- blockers_of excludes outgoing blocks.
- children_of returns descendant tree to depth.
- depth clamp at 3.
- token budgets: blockers_of <1000×4, children_of <1500×4.

---

## Task 5: `tickets.changed_since`

**Files:**
- Create: `src/tools/changed_since.ts` + `.test.ts`

**Decisions:**
- Args: `{ project?, since, field?, new_value?, limit? }`. `since` required ISO string; validate parseable (else InvalidParams). Default limit 100, clamp 1–500.
- SQL: `SELECT ticket_id, field, old_value, new_value, changed_at FROM audit_log WHERE project_id = ? AND changed_at >= ? [AND field = ?] [AND new_value = ?] ORDER BY changed_at DESC LIMIT ?`.
- Return `{ project, count, changes: [...] }`.

**Don't:**
- Don't return `old_value` for description-overwrite rows truncated — return as stored (the append rows already store only chunks per T7; overwrite rows may be large but that's the spec's accepted trade-off).
- Don't parse `since` loosely — require ISO 8601 (date or datetime). `new Date(since)` NaN check.

**Implement:** Tool.

**Verify:** Unit tests:
- returns rows since a timestamp, excludes older.
- `field` filter (e.g. only `status` changes).
- `new_value` filter (e.g. `new_value='done'` → completions).
- limit clamp.
- bad `since` → InvalidParams.
- token budget <1000×4.

---

## Task 6: `tickets.validate`

**Files:**
- Create: `src/tools/validate.ts` + `.test.ts`

**Decisions:**
- Args: `{ project? }`.
- Checks (each issue: `{ kind, severity, ticket_id, detail }`):
  - `orphan_parent` (severity `error`): `SELECT id, parent_id FROM tickets WHERE parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tickets p WHERE p.project_id = tickets.project_id AND p.id = tickets.parent_id)`.
  - `dangling_relation` (severity `error`): relation rows whose from_id or to_id has no ticket.
  - `closed_without_terminal_status` (severity `error`): `closed_at IS NOT NULL AND status NOT IN ('done','deferred')`.
  - `terminal_without_closed_at` (severity `info`): `status IN ('done','deferred') AND closed_at IS NULL`. **Info, not error** — spec §7 explicitly allows imported done tickets with NULL closed_at when no date was parseable.
- Return `{ project, ok, issues }`. `ok = !issues.some(i => i.severity === 'error')`.

**Don't:**
- Don't treat `terminal_without_closed_at` as an error — it's a legal post-migration state.
- Don't attempt to FIX anything — validate is read-only and reports.

**Implement:** Tool with four checks.

**Verify:** Unit tests:
- clean project → `ok: true, issues: []`.
- closed_at set + status open → one `error` issue, `ok: false`.
- done + closed_at null → one `info` issue, `ok: true`.
- (orphan/dangling are hard to create with FKs on; insert with `PRAGMA foreign_keys=OFF` in the test to fabricate the corrupt state, then assert detection. Document this in the test.)

---

## Task 7: Wire all six + E2E

**Files:**
- Modify: `src/server.ts` — register the six tools (registry → 20 tools).
- Modify: `tests/server.tools.test.ts` — add a `next` + `changed_since` + `validate` step.

**Decisions:**
- Registry now has 20 tools (14 + 6). Update the count assertion.
- E2E additions: after the existing flow (T1 done, T2 open, T1 blocks T2, T2 parent T1):
  - `tickets.next { project: "demo" }` → since T2 is blocked by... wait, T1 blocks T2 and T1 is `done`, so T2 is NOT blocked → next returns T2 (T1 is done, not open). Assert `ticket.id === "T2"`.
  - `tickets.blockers_of { id: "T2" }` → T1 (the blocker), even though done; assert it appears (blockers_of reports the edge regardless of blocker status — it's `next` that filters by blocker status).
  - `tickets.children_of { id: "T1" }` → T2.
  - `tickets.changed_since { since: "2000-01-01" }` → includes the status→done change.
  - `tickets.validate { project: "demo" }` → `ok: true`.

**Don't:**
- Don't restructure existing E2E steps.

**Implement:** Registry + E2E.

**Verify:** `tools/list` returns 20; E2E passes.

---

## Task 8: Full acceptance gate

**Verify:**
1. `npm run build` → exit 0.
2. `npm test` → exit 0; all green.
3. `npm run typecheck` → exit 0.
4. `node dist/server.js --help` → exit 0.
5. `grep -rn 'console\.' src/ tests/` → 0 hits.
6. Token budgets asserted in each tool's tests.

---

## Caveats & known risks

- **`next` blocker semantics are subtle**: a ticket is eligible if its only blockers are done/deferred. `blockers_of` reports ALL blockers regardless of status (it answers "what blocks this?", a structural question), while `next` filters to OPEN blockers (a workflow question). These are different by design — don't unify them.
- **Spec vs TICKETS.md discrepancies** (resolved above): blockers_of is INCOMING blocks (spec §5), default depths follow spec §6 (related=1, blockers_of=2, children_of=2). If the author wants TICKETS.md's numbers instead, it's a one-line change per tool.
- **Cycle safety**: `relates_to` is symmetric and `walkRelations(direction:both)` WILL revisit nodes without the `visited` guard. The guard is mandatory, not optional.
- **`validate` orphan/dangling checks**: with FKs ON these states are unreachable through the tools, so the tests must fabricate corruption via `PRAGMA foreign_keys=OFF`. The checks still earn their keep against manual DB edits or future hard-delete tools (spec §5 rationale for the audit_log decoupling).
- **`changed_since` `since` parsing**: accept ISO date (`2026-05-01`) and full datetime (`2026-05-01T12:00:00.000Z`). String comparison works because timestamps are lexicographically ordered ISO 8601 (spec §5). A bare date compares correctly against full datetimes.
- **Token budgets with enrichment**: `related`/`blockers_of`/`children_of` enrich ids with title+status. At depth 3 on a wide graph this could grow — the `limit`-free design relies on real ticket graphs being small. If a pathological graph blows the budget, add a node cap; not needed for v1 scale.

---

## Validation review

(none — six read tools over an established schema; the graph primitive is the only shared logic and it has dedicated tests. The spec/TICKETS.md reconciliation is documented above.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier subagent, fresh context)
**Branch:** main (unstaged at review time)

### Verification Results
- `npm run build` → exit 0; `dist/server.js` 89.83 KB.
- `npm test` → exit 0; **258/258 tests** across 36 files (was 200/29).
- `npm run typecheck` → exit 0.
- `node dist/server.js --help` → exit 0.
- `grep -rn 'console\.' src/ tests/` → 0 hits.
- All 35 T8 acceptance criteria verified, including the four critical semantics.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | All 35 acceptance criteria (6 tools, graph primitive, budgets, read-only, allowAll:false) | Completed as planned | — |
| 2 | `next` correctly treats done blockers as non-blocking; `blockers_of` uses INCOMING direction; `validate` terminal_without_closed_at is `info` not `error`; graph cycle guard terminates on relates_to loop | Completed as planned | All four reconciled semantics verified by dedicated tests |
| 3 | **`server.stdio.test.ts` + `server.shutdown.test.ts` spawned the server WITHOUT `TICKETGRAPH_DB_PATH`, opening the real `~/.claude/tickets.db` since T3** | Deviation (BUG, pre-existing from T2) | Fixed in-line — both now spawn against an isolated `mkdtempSync` temp DB with cleanup. Violated spec §16 ("tests never touch the live DB") and was a CI landmine (fresh machine has no/odd `~/.claude/tickets.db`). |
| 4 | `next.test.ts` "done blocker eligible" test creates a throwaway second `setup()` (dead code) | Nit | Deferred — harmless, cleaned by afterEach |
| 5 | `changed_since` accepts any `new Date()`-parseable string, not strictly ISO-only | Nit | Deferred — spec says "ISO date or datetime"; any parseable date is functionally fine for v1 |

### Technical Context & Learnings
- **`src/lib/graph.ts`** is the shared BFS primitive: `walkRelations({direction, kinds, maxDepth})` and `walkChildren`. Both use a visited-set guard seeded with the start id — mandatory because `relates_to` is symmetric and would otherwise infinite-loop.
- **`next` vs `blockers_of` answer different questions**: `next` filters blockers by OPEN status (workflow: "what can I work on?"); `blockers_of` reports ALL blockers structurally (analysis: "what blocks this?"). They are intentionally NOT unified.
- **`blockers_of(X)` = INCOMING `blocks` edges** (`to_id = X`, blocker is `from_id`) per spec §5 direction convention. TICKETS.md's "outgoing" wording was an error; the spec won.
- **Default depths** (spec §6): related=1, blockers_of=2, children_of=2; all clamp to max 3.
- **`validate` severities**: orphan_parent / dangling_relation / closed_without_terminal_status = `error`; terminal_without_closed_at = `info` (legal post-import per spec §7). `ok = no error-severity issues`.
- **CRITICAL test-hygiene fix**: spawned-server integration tests MUST set `TICKETGRAPH_DB_PATH` to a temp path. Any future test that spawns `dist/server.js` inherits the server's startup `openDb()`, which defaults to `~/.claude/tickets.db`. The pattern is now established in all four spawn-based test files (stdio, shutdown, bootstrap, tools).

### Items Requiring Rework
None.

### Deferred/Skipped Items
- `next.test.ts` dead `setup()` cleanup; stricter ISO validation in `changed_since`. Both nits.
- Cross-project (`project: "all"`) variants of `changed_since`/`validate` — possible future enhancement; not in spec scope.
