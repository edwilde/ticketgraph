# T27 — Cut the token cost of the "outstanding tickets" read path — Implementation Plan

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task. TDD throughout (design spec §16: three layers, version-controlled fixtures, every Acceptance bullet maps to a named test).

**Goal:** Make answering "outstanding tickets?" a one- or two-call operation instead of the 9-call escalation captured in T27's two traces, by fixing `get` detail rendering, multi-id handling, empty-`next` explanation, and adding a not-done view — across CLI, MCP, and the skill.
**Architecture:** Two "smart" fixes land in the **shared tool layer** (`next.ts`, `list.ts`) so **both MCP tool calls and the CLI** inherit them. Two front-end fixes land in the **CLI only** (`format.ts` detail rendering, `flags.ts` multi-id), because the MCP already returns full objects and takes structured input. The **skill + `--help`** make the cheap paths discoverable.
**Tech Stack:** TypeScript (NodeNext, strict), better-sqlite3, vitest. Pure tool layer (`parseArgs → handle → plain data`) + two CLI front-ends over one `makeToolRegistry`.
**Project context cache:** not used this run (project invariants read directly from `CLAUDE.md` + design spec).

---

## Ticket-scoped context

- **Two real traces back this ticket** (both in `.ai/TICKETS.md` T27): the 4-ticket read-path session (2026-06-03) and the empty-board session (2026-06-04, 152/155 done, 3 left all blocked/deferred). Each task below cites which trace failure it closes.
- **Surface split (the user's framing, confirmed against the code):**
  - *Shared tool layer (MCP + CLI both benefit):* empty-`next` reason (`src/tools/next.ts`), `--status outstanding` (`src/tools/list.ts`).
  - *CLI front-end only:* `get` full-body compact/table (`src/cli/format.ts`), multi-id (`src/cli/flags.ts`). MCP already returns the full ticket object and takes structured `ids`, so these are front-end rendering/parsing faults, not tool faults.
  - *Skill / docs:* `skills/ticketgraph/SKILL.md`, generated `--help`.
- **Valid statuses (verified, `001_init.sql` + `update.ts:98`):** `open, in_progress, blocked, done, deferred`. The `closed_at` trigger treats `done`+`deferred` as terminal — but for THIS ticket `outstanding` = **everything except `done`** (deferred is parked-but-extant; trace-2's whole problem was the default filter hiding the deferred ticket). So `outstanding ≡ status != 'done'`.
- **`formatResult(cliName, result, fmt)`** already threads `cliName` (today unused — comment at `format.ts:215-216` calls it "reserved for future per-command nuance"). That is the hook for the `get`-specific detail branch. No signature change needed.
- **`reason` shape must not branch the hit case.** `next` today returns `{ticket, reason:{priority,age_days,no_open_blockers}}` on a hit and `{ticket:null, reason:null}` when empty. Keep both unchanged; add an **optional top-level `message`** present only on the empty path. Avoids the two-object-shapes-in-one-field hazard the project flagged in T19, and `compactObject` renders it as `message=…`.
- **Doc bug to fix in passing:** `SKILL.md:28` already advertises `ticketgraph get --ids T1 T2 T3` — which does **not** work today (trace-2's exact failure). Task 4 makes it true; Task 6 keeps the doc honest.

---

## Task 1: Empty `next` explains why (shared tool layer — MCP + CLI)

Closes **trace-2 item 1** (blank `next` indistinguishable from a broken call). Lands in the tool, so an MCP `tickets.next` call and `ticketgraph next` both improve.

**Files:**
- Modify: `src/tools/next.ts` (the `if (!row)` branch at `next.ts:89-91`; `NextResult` type at `next.ts:25-32`; tool `description` at `next.ts:37-41`)
- Modify/Create test: `src/tools/next.test.ts`

**Depends on:** Task 2 (the message points at `list --status outstanding` — build that command first so the reference is honest). Low-risk (string reference only), but order Task 2 ahead.

**Decisions:**
- **TDD ordering (avoid an ERROR-not-FAIL red):** add the optional `message?: string` to `NextResult` (`next.ts:25-32`) as the FIRST sub-step, leaving the empty return unpopulated. Only then write the failing assertion. With the field declared-but-`undefined`, `expect(result.message).toContain(...)` is a real AssertionError red; without the field first, referencing `result.message` is a TS compile error (the whole file ERRORs, not fails).
- On empty, query a single grouped count of **all non-`done`** statuses for the project (`SELECT status, COUNT(*) … WHERE project_id=? AND status!='done' GROUP BY status`) and build a one-line `message`. **Enumerate every non-done status present, including `in_progress`** — not just blocked/deferred. `next` only selects `status='open'` (`next.ts:70`), so the empty path can legitimately have `in_progress` work; a message that names only "blocked, deferred" would mislead.
- **Two message branches, both specified:** (a) counts present → `no open tickets; 2 blocked, 1 in_progress, 1 deferred — run \`ticketgraph list --status outstanding\``; (b) zero non-done rows (truly clear board) → `no open tickets — board is clear` with no dangling `;`/`—`. Reuse `projectId` resolved at `next.ts:63-64`; do not re-resolve.
- Return shape on empty: `{ ticket: null, reason: null, message: string }`. `message` is **optional** on `NextResult` and absent on the hit path — *because* the hit path's shape and existing tests must stay byte-identical, and a model checks `ticket` first anyway.
- Update the tool `description` to state that an empty result carries a `message` explaining the board state.

**Don't:**
- Don't change the hit-path `reason` object or its fields — existing `next` tests and any MCP consumer depend on it.
- Don't fold the explanation *into* `reason` (would make `reason` two different object shapes — the T19 accuracy hazard).
- Don't leave the `message` unbounded — the whole ticket is about token cost; keep it to one short line and guard it with a byte-budget assertion.

**Implement:** Add `message?` to `NextResult`; when no qualifying row, compute the not-done status counts for the project and return `{ticket:null, reason:null, message}` where `message` enumerates all non-done counts (or the clean-board variant) and points at `list --status outstanding`.

**Verify:** TDD, state built in-test via the existing `setup()`/`addTicket` helpers (`next.test.ts:23-69` — there is NO shared fixture file). New tests: (1) `next: empty board (blocked+in_progress+deferred) returns a message naming all non-done counts` asserts `result.ticket === null` and `result.message` contains each count and `outstanding`; (2) `next: truly empty project returns "board is clear"` (covers the existing all-empty case at `next.test.ts:140` with the new logic, no dangling separators); (3) `next: empty message stays within a small byte budget` (e.g. `Buffer.byteLength(message) < 200`, mirroring the inline byte-count pattern at `next.test.ts:167`). Existing `next` hit-path and empty-`reason` tests (assert only `ticket`/`reason` null) stay green unchanged.

---

## Task 2: `list --status outstanding` (shared tool layer — MCP + CLI)

Closes **trace-2 item 2** (no single "is anything outstanding?" view; default filter hides deferred, `all` drowns it in done rows). Tool-layer, so MCP `tickets.list({status:"outstanding"})` and `ticketgraph list --status outstanding` both gain it.

**Files:**
- Modify: `src/tools/list.ts` (status-filter branch at `list.ts:111-127`; `status` property `description` in `inputSchema` at `list.ts:42-47`; tool `description` at `list.ts:35-37`)
- Modify/Create test: `src/tools/list.test.ts`

**Decisions:**
- Add a third sentinel alongside `"all"`: `status === "outstanding"` → WHERE `t.status != 'done'`. Implemented as `!= 'done'` rather than the spec's literal enumerated list (`open/in_progress/blocked/deferred`); the two are **equivalent under the closed 5-status enum** (verified `001_init.sql` + `update.ts:98`) and `!= 'done'` is superset-safe (it can never *hide* a non-done status the enum later gains). Note this choice in the code comment so `review-implementation` doesn't flag it as a spec deviation.
- **Validate `status` in `list.parseArgs` (NEW — closes a footgun the ticket is about).** Today `list` does no status validation, so `--status outstandng` (typo) silently falls into the `t.status = 'outstandng'` equality branch and returns `(none)` — exactly the silent-empty-result trap T27 is trying to kill. Add validation: a string `status` must be one of the 5 known statuses ∪ `{all, outstanding}`; an array must contain only known statuses; otherwise throw `McpError(InvalidParams)` naming the bad value. Reuse the `VALID_STATUSES` set pattern from `update.ts:165`/`add.ts:98`.
- Add a `description` to the `status` property naming the two sentinels and the default, e.g. `"open/in_progress/blocked (default), or 'all', or 'outstanding' (everything not done)"`. This is also the **`--help` discoverability hook** — `buildCommandHelp` renders property descriptions (`commands.ts:149-151`), so `ticketgraph list --help` will surface it with no hand-maintained help text.
- Update the tool `description` one-liner to mention `outstanding`.
- **CLI single-use yields a scalar:** `ticketgraph list --status outstanding` reaches the tool as the string `"outstanding"` (single-use `oneOf` → scalar, `flags.ts:144`), so the `statusArg === "outstanding"` check matches. Assert this in a test — a regression in Task 4's flag work that turned it into `["outstanding"]` would silently fall into the `IN (...)` branch and match zero rows.

**Don't:**
- Don't redefine the existing default filter or `"all"` — only add the new sentinel.
- Don't treat `deferred` as excluded — that would reproduce the exact bug (trace-2's hidden T48).
- Don't let an unknown status string fall through to a silent-empty result — validation must throw.

**Implement:** Add status validation to `parseArgs` (known statuses ∪ all/outstanding, else throw); add an `else if (statusArg === "outstanding")` branch emitting `t.status != 'done'`; document the sentinel in the `status` property description and the tool description.

**Verify:** TDD, state built in-test via the existing `setup()`/`addTicket` helpers (`list.test.ts:23-64` — no shared fixture file). New tests: (1) `list status=outstanding includes deferred and excludes done`; (2) `list status=outstanding is a superset of the default filter`; (3) `list status=<bogus> throws InvalidParams` (the typo now fails loudly, not silently empty); (4) CLI assertion that `--status outstanding` arrives as the scalar string. Existing default-filter and `status=all` tests stay green.

---

## Task 3: `get` renders the full ticket body in compact/table (CLI front-end)

Closes **trace-1 item 2 / trace-2 item 4** (`get` compact shows the same 6-column row as `list`, hiding description/tags/relations → forced `--help` + JSON fallbacks). CLI-only: the MCP `get` already returns the full object. **Split into 3a (single) then 3b (batch)** so each is an independent red→green.

**CRITICAL placement constraint (this defeated the first draft):** `formatResult` calls `rowsOf(result)` and returns at `format.ts:222-225` **before** any `cliName` logic, and `rowsOf` already matches `get`'s shapes — it wraps single `{ticket}` (`format.ts:66-67`) and intercepts `{tickets:[…]}` via the `"tickets"` entry in `ROW_KEYS` (`format.ts:46`). So a `get` branch added *inside the body, below* the `rowsOf` short-circuit is **dead code** for the exact shapes it targets. The `get` branch MUST be added **above** the `const rows = rowsOf(result)` call (an early `if (cliName === "get" && fmt !== "json") return formatGetDetail(result, fmt)`), with the `if (fmt === "json")` early-return still first so JSON stays byte-identical.

**Files:**
- Modify: `src/cli/format.ts` (insert the `get` branch before `format.ts:222`; add a `formatGetDetail` renderer)
- Modify test: `src/cli/format.test.ts` — **the existing `compact get: single {ticket} renders one line` test (`format.test.ts:172-175`, asserts the `"T9 "` row prefix) WILL break and must be REWRITTEN** to expect the detail block. This is an intended change, not a regression to "fix" by reverting the formatter. The sibling `add` case in that block must STAY a row/object — `add` returns a lean `{id,status,created_at}` (no `ticket` key, not a full ticket row), so it does not route through the `get` branch; keep its assertion.

### Task 3a — single-ticket detail block

**Decisions:**
- Add the early `get` branch (above `rowsOf`). `formatGetDetail` for a single `{ticket}`: key scalar lines (`id status priority type effort`), `title`, `description` verbatim, `tags`, and `relations` (outgoing/incoming grouped by kind, id-only — reuse the `scalarRef`/`->` convention at `format.ts:185`).
- `table` for `get` shares the detail renderer (a single ticket isn't a multi-row table) unless trivial to differentiate; both non-json formats render the detail block.

**Don't:** Don't drop any field the JSON shape carries; detail must be a superset of the old row, not a re-selection. Don't widen to `related`/`blockers_of` (out of scope — they keep grouped-object rendering).

**Verify:** TDD. New test `get compact shows description, tags and relations` (asserts body text appears AND differs from the 6-col `list` row); rewrite `format.test.ts:172-175` to the detail shape; `get compact stays under the single-ticket token budget` (inline `Buffer.byteLength` assertion — no shared harness exists; mirror `format.test.ts:227-246`). Existing list/search/stats/next/add format cases stay green.

### Task 3b — batch + null-slot + audit

**Decisions:**
- Handle `{tickets:[…]}`: render each ticket's detail block separated by a blank line.
- A `null` entry in the batch (missing id) renders a clear, non-blank `(ticket not found)` line so a partial batch is legible. Render it **generically** — `get`'s result `{tickets:[null,…]}` does not carry the requested ids, and threading them through `formatResult` would mean a tool-shape or signature change (out of scope). Generic-but-non-blank is enough; the count still matches the request length positionally.
- `get --include_audit` adds `recent_audit`; render it only when present.

**Verify:** TDD. New tests `get batch renders each ticket` and `get batch null slot renders a non-blank not-found line`. Existing cases stay green.

---

## Task 4: Multi-id never silently drops ids (CLI front-end)

Closes **trace-1 item 4** (repeated `--id` silently last-wins → 1 of 3) and **trace-2 item 3** (`--ids T1 T2 T3` consumed only the first value, rest became positionals → `got 2` error). Three coherent, *general* flag rules — none `get`-special beyond the positional arity.

**Files:**
- Modify: `src/cli/flags.ts` (`bindPositionals` at `flags.ts:40-60`; `parseFlags` array/scalar branches at `flags.ts:137-153`; `PRIMARY_POSITIONAL` at `flags.ts:28-33`; the coercion-rules doc comment at `flags.ts:72-86`)
- Modify test: `src/cli/flags.test.ts`; add a CLI spawn assertion in `tests/cli.spawn.test.ts`.

**Spawn-test note (corrected):** the SIGKILL-timer afterEach gotcha applies only to long-lived MCP children; `runCliSpawn` children exit on their own and never touch the module `child` var (`cli.spawn.test.ts:38-40`), so the new CLI spawn test is unaffected by it. **But** the spawn fixture seeds an *empty* project — the multi-id test MUST first seed tickets via `add --format json` (capture the generated ids), then `get <id1> <id2> <id3>`; it must NOT assume `T1/T2/T3` exist (three `null` slots is not three tickets — that would be a false red). Mirror the existing single-`get` spawn test at `cli.spawn.test.ts:272-286`.

Implement as four independent red→green units (4a–4c are unit-tested edits at distinct sites; 4d is the integration assertion run last, after a rebuild reflects 4a–4c):

### Task 4a — R1: array flags consume a run of values
For an `array`-typed prop, greedily consume the maximal run of following non-`--` tokens (stop at the next `--flag` or end). Makes `--ids T1 T2 T3` → `["T1","T2","T3"]`. `--`-prefixed tokens terminate the run (`--ids T1 T2 --project x` is unambiguous). Repeated-flag form (`--ids a --ids b`) still accumulates — run-consumption only *adds* token-swallowing.
- **Don't (acknowledged scope):** this is general, so `add --tags a b` and `related --kinds a b` change behaviour too — today those tokens become positionals and `add` *throws* ("takes no positional"); under R1 they become `["a","b"]`. This converts an error into a sensible parse (an improvement), but it IS a behaviour change — add regression tests `add --tags a b → tags:[a,b]` and `related --kinds a b → kinds:[a,b]`, and confirm `flags.test.ts:49-57`'s repeated-`--kinds` accumulate assertion still passes.
- **Verify:** `--ids T1 T2 T3 → array`; `add --tags a b → [a,b]`; `related --kinds a b → [a,b]`; repeated-flag accumulate still green.

### Task 4b — R2: `get` binds multiple positionals to `ids`
`ticketgraph get T1 T2 T3` is the form the model instinctively typed in **both** traces — and today `bindPositionals` (`flags.ts:53-57`) throws on `positionals.length > 1` for every `PRIMARY_POSITIONAL` command, so it's the live trace-2 failure. R1 does NOT fix this (bare positionals aren't flags).
- **Concrete edit:** add a `MULTI_POSITIONAL: Record<string,string> = { get: "ids" }`. In `bindPositionals`: if `cliName` is in `MULTI_POSITIONAL`, set `values["ids"] = positionals` (the full array) and skip the >1 throw. **A SINGLE positional still binds to `id`** (keep `get` in `PRIMARY_POSITIONAL` too, checked first for length 1) — this preserves the single-`id` not-found-error semantics at `get.ts:124-131`; routing a lone `get T999` to `ids` would silently return `{tickets:[null]}` instead of erroring, a regression on the most common call.
- Keep single-id commands (`related`, `blockers_of`, `children_of`) one-positional (no `ids` param).
- **Verify:** `bindPositionals("get",["T1","T2","T3"],{})` → `{ids:["T1","T2","T3"]}`; `bindPositionals("get",["T1"],{})` → `{id:"T1"}`; `related` with 2 positionals still throws.

### Task 4c — R3: repeating a plain scalar flag throws (no silent last-wins)
In the final scalar `else` (`flags.ts:151`), if `seenCount > 1` for a non-array, non-`oneOf`-array prop, throw `FlagParseError` (→ exit 2) naming the flag: e.g. `--id given more than once; use --ids T1 T2 or positionals`. Excludes `oneOf+array` props (`list.status`) which legitimately switch scalar→array on repeat (`flags.ts:143-150`) — the existing `seenCount`/`hasArrayBranch` machinery already distinguishes them.
- **Verify:** `repeated --id throws a clear error`; `repeated --status still folds scalar→array (oneOf unaffected)`.

### Task 4d — CLI spawn integration (run last)
After 4a–4c land and a rebuild reflects them: seed three tickets via `add --format json`, capture their ids, then `ticketgraph get <id1> <id2> <id3> --format json` → assert `parsed.tickets.length === 3` and each `.id` matches a seeded id (Acceptance: multi-id returns all or fails loudly).

**Don't (global):** don't special-case `get` in *value* coercion — R1 is generic; only the positional arity (R2) keys off the command. Don't break `--key=value` or boolean-presence parsing. Don't reintroduce silent last-wins. Update the coercion-rules doc comment (`flags.ts:72-86`).

---

## Task 5: `get` tool description steers multi-fetch to `ids` (MCP)

Small MCP-surface polish so a model calling the tool natively avoids the dual-param footgun (trace-1 root-cause #4 lives in the schema exposing both `id` and `ids`).

**Files:**
- Modify: `src/tools/get.ts` (tool `description` at `get.ts:57-60`)
- Covered by existing `get` tests (no behaviour change).

**Decisions:**
- Sharpen the description: "Pass `id` for a single ticket; for **two or more, use `ids`** (array, max 10) — not repeated `id`." Keep both params (back-compat with docs/slash-commands/install examples and the single-id not-found semantics at `get.ts:124-131`); just steer usage.
- Do **not** remove `id` or restructure the schema — out of scope and back-compat-breaking; the CLI fixes (Task 4) already remove the front-end footgun.

**Implement:** Reword the `tickets.get` description to direct multi-fetch to `ids`.

**Verify:** Existing `get` tests stay green; a doc/string assertion (or the registry-help test) confirms the description mentions `ids` for multiple.

---

## Task 6: Discoverability — SKILL.md + docs (skill surface)

Closes **trace-1 item 1 / item 3** (no alias for "outstanding"; the one-call `list --include_description` path is undiscoverable; `--help` round-trips) and keeps `SKILL.md` honest about `get`.

**Depends on:** Task 2 (`--status outstanding`), Task 4 (multi-id `get`), Task 1 (empty-`next` message) — this task documents all three *behaviours*, so it must land after them or the docs lie (as `SKILL.md:28` does today).

**Files:**
- Modify: `skills/ticketgraph/SKILL.md` (reading table ~`SKILL.md:22-35`; key-flags ~`SKILL.md:47-52`; common-mistakes ~`SKILL.md:54-59`)
- Modify: `README.md` and/or `docs/usage.md` — add the outstanding one-call path to the CLI examples (keep it brief; don't inline schemas).

**Decisions:**
- Add the **one-call outstanding path** explicitly: `ticketgraph list --status outstanding --include_description` answers "what's outstanding, with context" in ONE call. State that the default filter excludes `deferred` and `done`, and that `--status outstanding` includes deferred.
- Document that `ticketgraph get <id>` (and `get T1 T2 T3`) shows the **full body** in the default compact format — no `--format json` needed just to read a description.
- Fix the implicit promise at `SKILL.md:28`: `get --ids T1 T2 T3` now works (Task 4); also show the bare-positional `get T1 T2 T3` form.
- Add a `next`-returns-empty note: an empty `next` now carries a `message` — read it rather than re-querying.

**Don't:**
- Don't inline the full flag schema into `SKILL.md` (recreates the always-on schema tax the CLI epic removed — T26). Point at `--help`.

**Implement:** Update the SKILL reading table and notes to document `--status outstanding`, the one-call `--include_description` path, full-body `get`, working multi-id, and the empty-`next` message; mirror the outstanding example in README/usage.

**Verify:** The acceptance gate is **behavioural, not a grep** — a tautological doc-grep passes the moment the text is edited (that's exactly how `SKILL.md:28` came to advertise a broken `get --ids`). The real guards are Task 2's and Task 4d's spawn/unit tests proving the documented behaviours work. Keep a doc-grep that `SKILL.md` mentions `--status outstanding` only as a *secondary* check, and manually confirm the `get --ids`/positional advice now matches Task 4's behaviour.

---

## Task 7: Findings note — before/after call-count + token cost

Required by Acceptance ("Findings note in `.ai/` measuring the before/after call-count + token cost … the 9-calls→target comparison"), mirroring T20's methodology.

**Files:**
- Create: `.ai/2026-06-04-T27-read-path-findings.md`

**Depends on:** Tasks 1–4 landing (it measures their after-state).

**Decisions:**
- Reconstruct both scenarios via the in-test `setup()`/`addTicket` helpers (no shared fixture file exists): (a) the 4-ticket outstanding read (trace-1) and (b) the empty-board read (trace-2). Record calls + approx tokens **before** (from the traces) vs **after** (the new one/two-call paths: `list --status outstanding [--include_description]`; `next` reading its `message`; `get T1 T2 T3` in one call).
- **Cite the behavioural tests rather than re-measuring by hand** — the after-state call counts must be the ones the Task 2/3/4d tests actually exercise, so the headline metric is code-guarded, not narrative. A findings doc alone can claim success even if Task 3's renderer was dead code; point it at the passing tests.
- State the target plainly (e.g. 9 calls → 1–2) and note any item recorded as won't-do (P3 title truncation, below) with the reason.

**Implement:** Write the findings doc with the before/after table, citing the named tests that prove each after-path, and the won't-do record.

**Verify:** Doc exists, enumerates both scenarios with measured call counts, and references the specific tests (Task 2/3/4d) that back each after-figure; linked from the T27 review record.

---

## Task 8: Version bump + release (0.7.0)

**Depends on:** Tasks 1–7 all committed and green — this is the terminal task. Confirm `npm run build && npm test` is fully green **before touching any version file**; if a subagent-driven run parallelised tasks, verify 1–7 are merged first.

User-visible behaviour change on both surfaces → **minor** bump per `CLAUDE.md`. Every bump MUST end in a published GitHub release.

**Files:**
- Modify: `package.json` (`version`), `.claude-plugin/plugin.json` (`version` — drift-guard test enforces parity), `docs/install.md` (`tickets.ping` example version)

**Decisions:**
- Bump `0.6.0 → 0.7.0` (new `list --status outstanding`, smarter `next`, multi-id, full-body `get`). Keep `package.json` and `.claude-plugin/plugin.json` in sync (drift-guard test).
- After `npm run build` + full suite green: annotated tag `v0.7.0`, push, then `gh release create v0.7.0 --title … --notes …`.

**Don't:**
- Don't tag without a GitHub release — a pushed tag with no release is incomplete (`CLAUDE.md`). If `gh release create` fails (auth/network) after the tag is pushed, **delete the tag** (`git push --delete origin v0.7.0` + local) to avoid leaving the repo in the forbidden tag-without-release state; fix the cause and redo tag+release together.

**Implement:** Confirm full suite green first; bump the two manifests + the install-doc ping example; rebuild + retest; create the annotated tag and the GitHub release in the same step.

**Verify:** `npm run build` clean, `npm test` fully green, drift-guard test passes, `gh release view v0.7.0` shows the published release. Also grep the repo for any other pinned `0.6.0` (`rg "0\.6\.0"`) to confirm no version reference was missed.

---

## Caveats & known risks

- **P3 title truncation (60 chars, `format.ts:27`) — recorded as WON'T-DO.** The ticket says drop it if the P1 items remove the need; they do — `get` detail (Task 3) shows full titles+bodies, and `--format table` handles multi-row reads. Note this in the findings doc rather than widening `TITLE_MAX` (which would inflate every `list` row's token cost — counter to the ticket's mission).
- **Reason-shape discipline:** Task 1 adds `message` only on the empty path; do not let it leak onto the hit path or existing `next` tests/MCP consumers break.
- **`outstanding` semantics are deliberate:** includes `deferred`. If a reviewer expects "outstanding = actionable only", that's a different view — keep this one as "not done" (it's what trace-2 needed) and note the choice.
- **Spawn-test SIGKILL-timer gotcha (does NOT apply here — corrected by review):** that gotcha is about long-lived MCP children; `runCliSpawn` children exit on their own and never touch the module `child` var (`cli.spawn.test.ts:38-40`). The new CLI multi-id spawn test is unaffected — but it MUST seed its own tickets first (Task 4d), not assume ids exist.
- **`formatResult` ordering (Task 3):** the `get` branch must precede the `rowsOf` short-circuit at `format.ts:222`, or it's dead code. Highest-leverage failure mode — verify the new test fails on the *unmodified* formatter first (genuine red).
- **Determinism:** the empty-`next` count query and `outstanding` filter must produce stable output; assert against in-test-built state, not wall-clock.

---

## Validation review

No Opus validation pass (no hard trigger; clear siblings exist for every task: T24 for formatting, T22/T25 for flags/help, T5/T8 for the tool layer).

**`devils-advocate` pass (2026-06-04, 3 parallel challengers, all code-verified) — fixes applied:**
- **[Blocking] `get` detail branch was dead code as first drafted.** `formatResult` runs `rowsOf()` and returns *before* any `cliName` logic, and `rowsOf` already matches `{ticket}` and `{tickets}` (via `ROW_KEYS`). Task 3 now mandates the branch go **above** the `rowsOf` short-circuit.
- **[Blocking] Existing `format.test.ts:172-175` will break** (asserts the old one-line `get` row). Task 3 now explicitly rewrites it as an intended change, and keeps the `add` case as a row/object.
- **[Blocking] `get T1 T2 T3` still threw** — R1 only fixed `--ids`; `bindPositionals` throws on >1 positional. Task 4b now gives the concrete `MULTI_POSITIONAL` edit, with a single positional still binding `id` to preserve not-found-error semantics.
- **[Important] R1 silently changes `add --tags a b` / `related --kinds a b`** — now acknowledged with regression tests (Task 4a).
- **[Important] No shared fixture exists** — "seeded fixture" reworded to in-test `setup()`/`addTicket` construction throughout (Tasks 1, 2, 7).
- **[Important] Spawn test must seed 3 tickets**, not assume `T1/T2/T3` (Task 4d). The SIGKILL-timer afterEach gotcha does NOT apply to CLI spawn children (corrected).
- **[Important] Task 1 TDD red would ERROR (compile) not FAIL** unless `message?` is added to `NextResult` first (now sub-step 1). Message must enumerate `in_progress` too, handle the clean-board branch, and is byte-budget-guarded.
- **[Important] `--status` had no validation** → typo silently returns empty. Task 2 now validates and throws (closes a footgun the ticket is about).
- **[Important] Doc-grep acceptance was tautological** (Task 6) — re-anchored on Task 2/4d behavioural tests.
- **[Note] Task 8 dependency + failed-release tag cleanup** made explicit.
- Task 3 split into 3a/3b; Task 4 split into 4a–4d for clean red→green commits.
- **Ordering:** build Task 2 before Task 1 (message references the new command); Task 3 before Task 4 (coherent single CLI rebuild before the integration assertion); 6/7/8 after the behaviour tasks.

---

## Review record

**Reviewed:** 2026-06-04
**Reviewer:** Claude (Opus subagent, fresh context) — independent review-implementation pass
**Branch:** main
**Commit at review:** 984513e (released as v0.7.0)

### Verification results
- **Build:** clean (`tsup` success).
- **Tests:** 672 passed / 672 (55 files), 0 failed, 0 skipped.
- **Release:** v0.7.0 tagged AND published as a GitHub release; `package.json` + `.claude-plugin/plugin.json` in sync (drift-guard green). Residual `0.6.0` hits are transitive deps in `package-lock.json` + historical doc text only.

### Build sequence (as-built)
Tasks landed in the planned order with two-stage review (spec then quality) per task and fix loops where review found issues:
- **Task 2** (`ee3a0be`) — `list --status outstanding` + status validation. Approved; quality review noted `VALID_STATUSES` is now triplicated (deliberate pre-existing pattern, deferred) and `search.ts` shares the silent-empty footgun (follow-up).
- **Task 1** (`a4ed8a5` + fix `71e7d6e` + `664b078`) — empty-`next` message. Spec review caught a **blocking** self-contradictory headline (`"no open tickets; 2 open"`); fixed to `"nothing ready to work on"`. Determinism follow-up added `ORDER BY status`.
- **Task 3a/3b** (`f2cb38a`, `7c932b4` + test reframe `008bcff`) — `get` full-body detail. Branch correctly placed above `rowsOf` (the dead-code trap the devils-advocate flagged). Budget test reframed to bound formatting *overhead* (description is verbatim payload).
- **Task 4a–4d** (`3f8574c`, `9ab25a6`, `44d279d`, `1e93e81` + review follow-up `89a285b`) — multi-id CLI. Quality review found the array-run-consumption order hazard (Finding 2); resolved as documented + tested constraint.
- **Task 5** (`abeebf6`) — `get` tool description steers multi-fetch to `ids` (MCP).
- **Task 6** (`234fabd`) — SKILL/README/usage docs; every claim verified against the live CLI.
- **Task 7** (`c609181`) — findings doc `.ai/2026-06-04-T27-read-path-findings.md`.
- **Task 8** (`984513e`) — v0.7.0 bump + GitHub release.

### Triage summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | `search.ts` retains the silent-empty status footgun Task 2 fixed for `list` (`search.ts:147-149`, no validation) | Deviation (out-of-scope) | **Deferred** — filed as follow-up ticket T29; pre-existing, not a T27 regression |
| 2 | Array-flag run-consumption (4a) is general → `related --kinds a b T5` absorbs the trailing id; resolved as documented + tested order constraint, not a narrowed rule | Deviation (deliberate) | **Approved** — standard variadic-CLI behaviour; operator (Claude) uses positional-first per SKILL; pinned by tests |
| 3 | `outstanding` implemented as `status != 'done'` rather than the spec's enumerated list | Deviation (deliberate) | **Approved** — equivalent under the closed 5-status enum; superset-safe under enum growth; same predicate as `next`'s count query |
| 4 | Task 3b code landed in the 3a commit (shared `formatGetDetail`/`ticketDetail`); both arms independently tested | Process note | **Approved** — renderer is one function with two arms; commits + tests are genuinely split |
| 5 | P3 title-truncation recorded as WON'T-DO | Scope decision (as planned) | **Approved** — full-body `get` + `--format table` remove the need; widening `TITLE_MAX` would inflate every `list` row's tokens |
| — | Empty-`next` uses a top-level `message` field rather than populating `reason` | Deviation (deliberate, Task 1) | **Approved** — avoids the T19 two-shapes-in-one-field hazard; keeps the hit-path `reason` byte-identical; satisfies AC#3's intent |

All 7 T27 acceptance criteria (`.ai/TICKETS.md`) verified met, each mapped to code + a named test.

### Technical context & learnings (reusable)
- **`formatResult` ordering is load-bearing:** per-command early returns must precede `rowsOf` (`format.ts:303` json → `307` get → `309` rowsOf). `rowsOf` matches both `{ticket}` and `{tickets}` via `ROW_KEYS`, so any per-command branch added *below* it is dead code for those shapes.
- **`outstanding` ≡ `status != 'done'`** under the closed enum (`open/in_progress/blocked/done/deferred`); used identically in `list.ts:149` and the `next` empty-count query (`next.ts:94`).
- **Array-flag run-consumption is global** (`flags.ts:171-174`): every array-typed prop (`get.ids`, `add.tags`, `related.kinds`) swallows the trailing token run, so **bare positionals must precede a variadic flag** or they get absorbed (pinned by `flags.test.ts:126-139`). `oneOf+array` props (`list.status`) are exempt from the repeated-scalar throw.
- **`get` keeps both `id` and `ids`:** CLI single positional → `id` (errors on miss), 2+ positionals → `ids` (`{tickets:[null]}` on miss, no throw). Empty-`next` carries an optional top-level `message` — consumers check `ticket === null` then read `message`.

### Items requiring rework
None. No finding was denied.

### Deferred/skipped items
- **`search.ts` status validation** (T29) — same silent-empty footgun `list` now rejects; mechanical copy of `list.ts:91-108`. Pre-existing; does not gate T27.
- **P3 compact title truncation** — WON'T-DO (see findings doc rationale).
- **`VALID_STATUSES` triplication** (`list.ts`/`update.ts`/`add.ts`) — deliberate pre-existing local-duplication pattern; extract on the next status-set change.
