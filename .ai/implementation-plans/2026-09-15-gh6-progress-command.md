# Token-cheap `progress` command Implementation Plan

> **For the implementer:** Use `executing-plans` (or `subagent-driven-development`) to implement task-by-task.

**Source:** GitHub issue #6 (https://github.com/edwilde/ticketgraph/issues/6)
**Goal:** Answer "how far through this backlog am I" in one call, points-based, with an optional per-group breakdown, at a fraction of the token cost of `stats`.
**Architecture:** A new pure tool `tickets.progress` (`src/tools/progress.ts`) returns a lossless count structure; the CLI front end renders it via a per-command branch in `formatResult` that owns the bar and group-row rendering. The tool is registered once in `registry.ts` and thereby appears on both the MCP and CLI surfaces with no further wiring.
**Tech Stack:** TypeScript ESM, better-sqlite3, vitest.
**Project context cache:** `~/.claude/projects/-Users-edwilde-Scripts-ticketgraph/writing-plans-cache.md` (refreshed 2026-09-15)

---

## Ticket-scoped context

- `stats` (`src/tools/stats.ts`) is the sibling: same `requireProject(..., { allowAll: true })` call, same `projectFilter`/`projectParam` idiom for `project: "all"`. Its test file (`src/tools/stats.test.ts`) has the `setup()` / `insertTicket()` helpers and a byte-budget test to copy.
- `formatResult` in `src/cli/format.ts:328` is shape-driven. Its `isStats()` detector (`format.ts:158`) fires on any object with `totals` plus a `by_*` key, so a progress result **would be mis-rendered as stats** unless a `cliName === "progress"` branch precedes both `rowsOf` and `isStats`. The `get` branch at `format.ts:333` is the precedent for a per-command branch and shows where it must sit.
- CLI flags derive from `inputSchema` automatically (`src/cli/flags.ts`); an `enum` on a string property renders as `one of: a|b|c` in `<command> --help` (`src/cli/commands.ts:buildCommandHelp`), and the property `description` is appended. There is no separate help file: the "`--by tag` can exceed the total" note lives in the schema property description.
- `--format` is stripped globally in `runCli` (`src/cli/index.ts`) and reaches `formatResult` as `fmt`; the tool never sees it.
- Schema (`src/migrations/001_init.sql`): `tickets.effort` is nullable Fibonacci; `epic` and `parent_id` nullable; `type` NOT NULL; tags live in a separate `tags (project_id, ticket_id, tag)` table, so `--by tag` is a LEFT JOIN and a ticket with no tags must still produce a `(none)` row.
- `tests/server.tools.test.ts:116` asserts the registry has exactly 23 tools; it becomes 24.
- Docs that list commands and must gain `progress`: `README.md:50,103,153,166`, `docs/usage.md:20,47,58`, `skills/ticketgraph/SKILL.md:32`. `docs/install.md:187` carries the `tickets.ping` example version.
- Version bump is **minor** (new user-visible command): `0.15.2` → `0.16.0` in `package.json` and `.claude-plugin/plugin.json` (drift-guard test), plus the `install.md` example. A GitHub release must follow the tag (CLAUDE.md).

---

## Task 1: `tickets.progress` tool: headline counts

**Files:**
- Create: `src/tools/progress.ts`
- Create: `src/tools/progress.test.ts` (copy `setup`/`insertTicket` from `src/tools/stats.test.ts:23-62`)

**Decisions:**
- Result shape (lossless, no bar string, absent-means-zero for statuses):
  ```
  { project, totals: { tickets, done_tickets, points, done_points, pct, unsized, basis },
    by_status: { open?, in_progress?, blocked?, done? },
    groups?: [...] }            // Task 2
  ```
  `by_status` omits zero-count keys *in the tool result* so the JSON path pays nothing for them; the formatter needs no omit logic.
- The population is `status IN ('open','in_progress','blocked','done')`. `deferred` is excluded from every figure, *because* a run that defers work must still be able to reach 100%.
- `points = SUM(effort)` over the population; `done_points` = same for `status = 'done'`. NULL effort contributes 0 and is counted in `unsized` (all statuses, not just open), so the points figure is never silently short.
- `pct = Math.round(100 * done_points / points)` when `points > 0`, `basis: "points"`. When `points === 0` (everything unsized, or empty project) fall back to `Math.round(100 * done_tickets / tickets)` with `basis: "tickets"`, and `0` with no tickets. *Because* a 0/0 headline is worse than a clearly labelled ticket-based one; `basis` keeps the JSON honest about which was used.
- One SQL statement for the headline using conditional aggregates (`SUM(CASE WHEN status='done' THEN COALESCE(effort,0) END)` etc.), parameterised by the `stats` `projectFilter` idiom. Put it behind a small internal `countRow(whereSql, params)` helper that Task 2 reuses with a `GROUP BY`.
- `parseArgs` accepts `project?: string` and `by?: string`; `by` is validated against the enum in `parseArgs` (throw `McpError(InvalidParams, ...)` naming the allowed values), mirroring how every other tool validates enums at the boundary.
- Tool `description` is one line and states the exclusion rule ("deferred tickets are excluded; percentage is points-based"). It is what `--help` and the MCP tool list show.

**Don't:**
- Don't put `points`/`tickets` under the `stats`-style `by_*`-only shape or omit `totals`: `totals` + `by_status` is deliberate, and the formatter branch in Task 3 keys off `cliName`, not shape.
- Don't count `deferred` in `unsized` or `tickets` even though it has NULL effort: it is outside the population entirely.

**Implement:** Write the tool factory `makeProgressTool(db, getClientRoots)` following `stats.ts`, with the shared count helper and the headline query only.

**Verify:** `progress.test.ts` tests, each mapping to a spec bullet:
- empty project → `tickets 0, points 0, pct 0, basis "tickets"`, `by_status {}`
- seed open(3), open(5), in_progress(null), blocked(2), done(2), done(null), deferred(8) → `tickets 6, done_tickets 2, points 12, done_points 2, pct 17, unsized 2, basis "points"`, `by_status {open:2,in_progress:1,blocked:1,done:2}` and no `deferred` key
- all-unsized seed (2 open, 2 done, no effort) → `pct 50, basis "tickets"`
- `project: "all"` aggregates across two projects
- `by: "bogus"` → `McpError` naming the four allowed values
- byte budget: 20 mixed tickets, `JSON.stringify(result)` < 400 bytes without `by`

---

## Task 2: `--by <epic|parent|type|tag>` groups

**Files:**
- Modify: `src/tools/progress.ts`
- Modify: `src/tools/progress.test.ts`

**Decisions:**
- `groups` is present only when `by` is given: `[{ key, tickets, done_tickets, points, done_points, pct, unsized }]`, same fields and the same `pct` fallback rule as `totals` (per group). No per-group `basis`; the headline `basis` already tells the reader whether points are trustworthy.
- Group column per `by`: `epic` → `epic`, `parent` → `parent_id`, `type` → `type`, `tag` → `tags.tag` via `LEFT JOIN tags ON tags.project_id = tickets.project_id AND tags.ticket_id = tickets.id`. NULL group value → key `"(none)"` (use `COALESCE(<col>, '(none)')` in SQL so the sort is stable and the formatter has nothing to translate).
- `--by tag` counts a ticket once per tag *by construction* of the join; the headline `totals` come from the Task 1 query (no join), so they are never inflated. State the double-count in the `by` property `description` so `progress --help` says it.
- Sort: `pct ASC`, then `key ASC` as a tiebreak, done in SQL (`ORDER BY`) so results are deterministic; laggards first is the point of the view.
- `project: "all"` without `by` reports the aggregated headline only (like `stats`). Grouping across all projects works with any `by` value. Cross-project group keys are not project-qualified in v1 (an `epic` named `core` in two projects merges); note this in Caveats rather than adding a fifth enum value.

**Don't:**
- Don't reuse the tag join for the headline query, or `unsized`/`points` double-count too.
- Don't compute `pct` in two places: derive the per-group `pct` (with the same fallback) in one helper shared with `totals`, then sort; whether the sort happens in `ORDER BY` or in JS is the implementer's call.

**Implement:** Extend the shared count helper to take an optional group expression and join clause; add the `by` enum to `inputSchema` with the tag caveat in its description.

**Verify:** tests:
- `by: "epic"` with epics `core`(done 1/1 pts) `infra`(0/2) and one null-epic ticket → three groups sorted `infra, (none), core` (or `(none)` first if its pct is lower; assert on pct order), `(none)` key present
- `by: "tag"`: one ticket tagged `a` and `b`, one untagged → groups `a`, `b`, `(none)`; sum of group `tickets` (3) exceeds `totals.tickets` (2)
- `by: "parent"` → `parent_id` used, `(none)` for roots
- `by: "type"` → no `(none)` row (type is NOT NULL)
- `progress --help` output (via `buildCommandHelp(tool)`) contains `one of: epic|parent|type|tag` and the word `exceed`
- byte budget: 20 tickets across 4 epics, `by: "epic"`, `< 800 bytes`

---

## Task 3: Bar and group rendering in `format.ts`

**Files:**
- Modify: `src/cli/format.ts` (new branch before `rowsOf` in `formatResult`, ~line 333; new helpers `progressBar`, `formatProgress`)
- Modify: `src/cli/format.test.ts` (new `describe("formatResult: progress")`)

**Decisions:**
- `progressBar(pct)` → 20 cells, `#` filled and `-` empty, filled = `Math.round(pct / 5)`, wrapped in `[` `]`. Exported so it can be unit-tested directly. *Because* the issue's examples (38%→8, 21%→4, 30%→6, 67%→13) all match round-to-nearest.
- Compact layout, exactly:
  ```
  progress <done_points>/<points> pts (<pct>%) | <done_tickets>/<tickets> tickets
  <status> <n>  <status> <n> ...  [unsized <n>]
  [####----------------] <pct>%
  ```
  Status line orders `open in_progress blocked done` (fixed, not insertion order), separated by two spaces, only keys present in `by_status`; `unsized` appended only when `> 0`. When `basis === "tickets"` the headline reads `(<pct>% by tickets)` so the fallback is visible.
- Group rows (compact) follow after a blank line, one per group in the tool's order: `<key padded to widest key>  <done_points>/<points> padded right  [bar] <pct>%`. Points, not tickets, in the row, *because* the headline is points-based and the rows should sum to it (except `tag`).
- `table` format: same three headline lines, then the existing `tableRows()` helper over the group rows with columns `group done total pct unsized` (so it is a real aligned table with a header). No bar in table cells. With no `groups`, `table` output equals `compact`.
- `json` is untouched: `formatResult` already returns `JSON.stringify(result)` first, and the tool result carries no bar string.
- Place the `progress` branch immediately after the `get` branch and before `rowsOf`. It must also precede `isStats`, which would otherwise claim the shape.

**Don't:**
- Don't build the bar in the tool or add it to `TResult`: JSON consumers render their own (issue requirement), and MCP tokens are billed on the JSON path.
- Don't make the renderer shape-driven for progress; key off `cliName` like `get`. A generic detector would collide with `isStats`.
- Don't emit zero-count statuses or `unsized 0`.

**Implement:** Add `progressBar` and a `formatProgress(result, fmt)` renderer; route `cliName === "progress"` to it in `formatResult`.

**Verify:** `format.test.ts`:
- `progressBar(38)` → `[########------------]`; `progressBar(0)` → all `-`; `progressBar(100)` → all `#`
- compact on the issue's example data reproduces the three headline lines verbatim from the issue
- compact omits absent statuses and `unsized` when 0; shows `unsized 3` when 3
- compact with groups: rows appear in tool order, widest key sets the padding, each row ends `<pct>%`
- table with groups: header line starts `group  done  total  pct  unsized`
- `formatResult("progress", r, "json")` equals `JSON.stringify(r)` and contains no `#`
- regression: `formatResult("stats", statsFixture, "compact")` unchanged (existing test still passes)

---

## Task 4: Registry, MCP surface, CLI end-to-end

**Files:**
- Modify: `src/registry.ts` (import + entry after `makeStatsTool`)
- Modify: `tests/server.tools.test.ts:98,116` (add `toContain("tickets.progress")`, `toHaveLength(24)`)
- Modify: `tests/cli.spawn.test.ts` (one spawn case)

**Decisions:**
- Register directly after `stats` so `--help` lists them adjacently.
- One CLI spawn test covers the full path: register project, add three tickets (one done with effort, one open with effort, one unsized), run `progress`, assert first stdout line matches `/^progress \d+\/\d+ pts \(\d+%\)/` and exit code 0; then `progress --by bogus` exits 2 with the enum names on stderr. Capture the child in a local in `afterEach` (see the existing tests' SIGKILL-timer pattern).

**Implement:** Add the registry entry and the two test updates.

**Verify:** `npm run build && npm test` green; `node dist/server.js progress --help` prints the `--by` enum line.

---

## Task 5: Docs, skill table, version, release

**Files:**
- Modify: `README.md:50` (quick-start line), `README.md:103` (command table row), `README.md:153` (read-command list), `README.md:166` (`--project all` list)
- Modify: `docs/usage.md:20,47,58`
- Modify: `skills/ticketgraph/SKILL.md:32` (row: "How far through the backlog am I / which area lags" → `ticketgraph progress [--by epic]`)
- Modify: `package.json`, `.claude-plugin/plugin.json` → `0.16.0`; `docs/install.md:187` example version
- Modify: `.ai/TICKETS.md` status table is for T-tickets only; add a one-paragraph "GH#6 landed" note in the changelog-style block under the table, matching the existing entries' style

**Decisions:**
- Command table row text: "Points-based completion with a 20-cell bar; `--by epic|parent|type|tag` for per-group rows; deferred excluded. Supports `--project all`."
- Release title `v0.16.0: progress command`; notes describe the command, not the plumbing.

**Don't:**
- Don't mention the branch history or the sibling-check reasoning in README or release notes.

**Implement:** Update the listed lines, bump versions, then tag `v0.16.0` and publish the GitHub release after the merge to `main`.

**Verify:** `npm test` (version drift-guard passes); `gh release view v0.16.0` succeeds after release.

---

## Caveats & known risks

- **`--project all` group keys merge across projects** (an epic named `core` in two projects is one row). Acceptable for v1; a project-qualified key or a `project` grouping is the upgrade path if it bites.
- **`pct` rounds independently per group**, so group rows do not visibly sum to the headline even without tags. Expected; the JSON carries exact points.
- **`tag` groups inflate `tickets`/`points` per group by design.** The only place this is explained is the `--by` help text; keep that sentence when editing the description.
- **`isStats` collision**: if the `progress` branch is ever moved below `rowsOf`/`isStats`, output silently degrades to the stats renderer. The regression test in Task 3 guards this only for the progress fixture; a future refactor of `formatResult` ordering needs both fixtures.
- **Effort is Fibonacci story points**, not hours; the bar reports relative completion of sized work only, and `unsized` is the honesty valve. Do not derive velocity or ETA from it (out of scope).

---

## Review record

(populated post-implementation by the `review-implementation` skill)
