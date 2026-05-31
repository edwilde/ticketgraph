# T24 — Output formatting (`--format compact|json|table`) — Implementation Plan

> **For the implementer:** Use `subagent-driven-development`. TDD throughout. Builds on the T22/T23 CLI (`src/cli/*`, 571 tests green).

**Goal:** Give the CLI three output formats — **compact** (default; aligned text, no repeated JSON keys → the per-call token win), **json** (today's exact single-line object, for parsing/scripting), **table** (human-pretty, header + aligned columns). Selection: `--format` flag › `TICKETGRAPH_FORMAT` env › `compact`. No TTY auto-detect.
**Architecture:** A new pure `src/cli/format.ts` (`formatResult(cliName, result, fmt) → string`) called by `dispatch` in place of today's `JSON.stringify(result)`. `runCli` extracts/validates the global `--format` flag (like `--verbose`) and threads it to `dispatch`. Errors (stderr) are never formatted — only the success result.
**Tech Stack:** TypeScript strict, vitest.

---

## Ticket-scoped context (verified against the code)

- **`dispatch.ts:54`** currently emits the success result as `JSON.stringify(result) + "\n"`. T24 replaces that single call with `formatResult(cliName, result, fmt) + "\n"`. Error paths (`code 1/2`, stderr, message-only) are untouched.
- **`runCli`** already extracts global flags (`--help`/`--version`/`--verbose`) before command parsing. `--format` joins them: parse its value, validate, strip from argv, pass to `dispatch` via `DispatchDeps`.
- **Result shapes** (verified):
  - **Row-collections:** `list` `{project,count,rows:[]}` · `search` `{project,count,hits:[]}` · `changed_since` `{project,count,changes:[]}` · `blockers_of` `{id,blockers:[]}` · `children_of` `{id,children:[]}`. Ticket rows carry `id,project_id,title,status,priority,type,effort,epic,parent_id,created_at,closed_at`.
  - **Single ticket:** `next` `{ticket:TicketRow|null,reason}` · `add` `{ticket}` · `update` `{ticket,audit_entries}` · `get` `{ticket}` OR `{tickets:[]}`.
  - **Count-maps:** `stats` `{project,by_status,by_priority,by_epic,by_type,by_effort,totals:{tickets,points}}`.
  - **Flat/grouped objects:** `link` `{from,to,kind,note,created_at}` · `register_project` `{id,display_name,root_path,created_at}` · `add_tag`/`remove_tag` `{tags:[]}` · `export` `{path,bytes,ticket_count,exported_at}` · `ping` `{ok,version,db_path}` · `add_many` `{created:[],count,warnings?}` · `related` `{id,outgoing:{kind:[]},incoming:{kind:[]}}`.

---

## Task 1: `--format` selection + validation in `runCli`

**Files:** Modify `src/cli/index.ts`; extend `src/cli/index.test.ts`.

**Decisions:**
- Resolve format precedence: `--format <val>` flag › `TICKETGRAPH_FORMAT` env › `"compact"`. Valid values: `compact|json|table`. Invalid (flag or env) → one-line stderr usage message + exit **2** (a usage error). **No TTY/`isTTY` auto-detect** — predictable for Claude.
- `--format` is a value-bearing global flag: support both `--format json` and `--format=json`, recognised anywhere, **stripped from argv** (both the flag and, for the space form, its value) before command/flag parsing — mirror how `--verbose` is stripped, but consume the value token too. A bare trailing `--format` with no value → exit 2.
- Thread the resolved `fmt` to `dispatch` via `DispatchDeps` (add `format?: Format`).

**Don't:**
- Don't auto-detect by TTY. Don't let `--format` reach a tool's flag parser. Don't apply format to error output (errors stay plain text).

**Verify (test-first):** red tests — `runCli` honours `--format=json`/`--format json`/`TICKETGRAPH_FORMAT`/default-compact; `--format bogus` → exit 2; explicit flag overrides the env; `--format` is stripped (a command with `--format json --project x` still parses `--project`).

---

## Task 2: The formatter — `src/cli/format.ts`

**Files:** Create `src/cli/format.ts` + `src/cli/format.test.ts`.

**Decisions — keep it GENERIC, one ticket-row override (resist per-tool bespoke formatters):**
- `export type Format = "compact" | "json" | "table"; export function formatResult(cliName: string, result: unknown, fmt: Format): string`.
- **json:** `JSON.stringify(result)` (single line — identical to today's default output, so `--format json` is byte-compatible with pre-T24 behaviour).
- Shared normalisation `rowsOf(result)`: return the primary array if present — first of `rows | hits | changes | children | blockers | tickets` — or wrap a single `{ticket}` as `[ticket]`; else `null` (not a row-collection).
- **Ticket columns** (ordered, when the row has them): `id  status  priority  type  effort  title`. `effort`/`priority` null → `-`; `title` truncated to ~60 chars for compact/table. Rows that aren't ticket-shaped fall back to their own scalar keys in declaration order.
- **compact** (default, token-lean, Claude-facing):
  - row-collection → **one line per row, single-space-joined column values, NO header** (matches the agreed preview). Empty collection → a single `(none)` line.
  - count-map (`stats`) → terse grouped line(s): `tickets=139 points=11` then `status: open=9 in_progress=1 …` etc., one group per line.
  - flat object → one `key=value` line (space-joined); arrays → `k=[a,b]`; one-level nested objects/maps → `k.sub=val`. (`related`'s outgoing/incoming render as `blocks->T2,T3` style groups.)
- **table** (human): same rows as compact but **with a header row + per-column width alignment** (pad to the max cell width per column); non-row objects → aligned `key   value` pairs. No box-drawing (keep plain).
- The formatter is **pure** (string in, string out — no I/O), so it is trivially unit-testable.

**Don't:**
- Don't write a bespoke branch per tool — `rowsOf` + the ticket-column set + the flat-object fallback cover everything; only add a special case if a shape genuinely can't render (none identified).
- Don't emit a header in compact mode (tokens). Header is table-only.
- Don't lose data silently in compact for flat objects — every scalar key appears (truncation applies to `title`/long text only, and is a display choice, not data loss; `--format json` is the lossless view).

**Verify (test-first):** stub-first; unit-test each format against representative seeded results: `list` (compact = headerless aligned rows shorter than JSON; table = header+aligned; json = exact object), `stats` (terse grouped), `add`/`get` single-ticket, a flat object (`link`), an empty collection (`(none)`). Assert json output `JSON.parse`s back to the original object.

---

## Task 3: Wire into `dispatch` + UPDATE existing JSON-default tests (CRITICAL)

**Files:** Modify `src/cli/dispatch.ts`; **update** `src/cli/dispatch.test.ts`, `tests/cli.spawn.test.ts` (and any other test that parses default stdout as JSON).

**Decisions:**
- `dispatch` takes the resolved `fmt` (via `DispatchDeps.format`, default `"compact"`) and emits `formatResult(cliName, result, fmt) + "\n"` on success (`dispatch.ts:54`). Error paths unchanged.
- **THE BREAKING CHANGE:** the default output is now **compact**, not JSON. Every existing test that does `JSON.parse(stdout)` on a default invocation will break. Audit and fix them: where a test asserts on the *data*, pass `--format json` (spawn) or `{format:"json"}` (dispatch unit) and keep parsing JSON; where appropriate, add/keep a compact assertion. Specifically review `dispatch.test.ts` (asserts `JSON.stringify(result)+"\n"`) and `tests/cli.spawn.test.ts` (bullets 2,5,6,7,8 parse stdout). This is the load-bearing integration step — the suite must be green AND the assertions must still be meaningful (not just made to pass).

**Don't:**
- Don't make tests pass by deleting assertions — convert data-correctness checks to `--format json` so they still verify the payload.
- Don't format error/stderr output.

**Verify:** full `npm test` green; the updated spawn tests prove `--format json` still yields parseable payloads and the default yields compact text; run the suite twice (spawn-sensitive) for determinism.

---

## Task 4: Token-delta measurement

**Files:** add a test/assertion (in `format.test.ts`) and a one-line note in the ticket/plan record.

**Decisions:**
- On a seeded multi-row `list` result, assert `compact.length < json.length` and record the measured char delta (a token proxy) — mirrors T20's methodology. This makes the "per-call token win" concrete, not asserted-by-hope.

**Verify:** the delta test passes and the measured saving is logged in the Review Record.

---

## Caveats & known risks

- **Default-format change is the whole risk surface.** It silently alters every default CLI invocation's stdout. Task 3's test audit is mandatory and must keep assertions meaningful. A green suite that only parses `--format json` everywhere would *hide* whether compact actually renders correctly — so keep at least one compact-output assertion per shape (list/stats/single-ticket).
- **Coordinate with T20's lean shapes:** compact renders whatever fields the (possibly T20-trimmed) result carries; don't reintroduce dropped fields. If T20 hasn't trimmed a shape, compact still works (it reads what's present).
- **`get` dual shape** (`{ticket}` vs `{tickets:[]}`): `rowsOf` handles both (wrap single, pass array). Test both.
- **Truncation is display-only:** `title` truncation in compact/table is not data loss — `--format json` is the lossless channel. State this where the truncation happens.
- **`related`'s nested groups** are the one awkward shape for compact; the `kind->id,id` rendering is the chosen representation — verify it reads sensibly, else fall back to the flat `k.sub=val` form.

---

## Validation review

Adversarial pass scaled to risk — the dominant risk (default JSON→compact breaking existing JSON-parsing tests) is pre-empted as the explicit, mandatory Task 3 with a "don't just make it pass" warning. Post-build code-review gate (fresh subagent) runs as for T22/T23.

---

## Review record

**Reviewed:** 2026-05-31 (fresh-context Opus implementer + Sonnet code-review gate; one fix loop).
**Verification:** build ✓, typecheck ✓, `npm test` **606 passed / 55 files** (+35 over T23's 571), two runs identical (spawn-deterministic).

### Result: APPROVED after one fix round (1 Blocking + 2 Important fixed; 4 Notes skipped as low-value).

**Built as planned:**
- Pure `formatResult(cliName, result, fmt)` (`src/cli/format.ts`); `dispatch` emits it in place of `JSON.stringify`. `--format` flag › `TICKETGRAPH_FORMAT` env › `compact`; invalid → exit 2; no TTY auto-detect; `--format` (+ its space-form value) stripped from argv.
- Generic formatter: `rowsOf` (rows|hits|changes|children|blockers|tickets, or `{ticket}`→`[ticket]`); ticket columns `id status priority type effort title` (null→`-`, title truncated ~60, display-only); compact = headerless rows / terse grouped stats / `k=value` flat; table = header + width-aligned; json = single-line exact object (byte-compatible with pre-T24 default).
- **Breaking-change audit done honestly:** every pre-T24 `JSON.parse(stdout)` test moved to `--format json` with payload assertions retained, PLUS new compact-output assertions for all 7 shapes (list/empty/stats/single-ticket/flat/related/add_many). Reviewer confirmed no assertion was gutted.

**The per-call token win (Task 4, measured):** seeded 10-row `list` → **json 2111 chars, compact 391 chars — 81.5% smaller**. Asserted `compact.length < json.length` with a 40% threshold.

**Fix round (review → green):**
| # | Finding | Sev | Fix |
|---|---------|-----|-----|
| 1 | `--format table` on an EMPTY collection crashed (`headerFor([])` → `'id' in undefined` TypeError) — and was untested | Blocking | `headerFor` guards `rows.length===0` → `[...TICKET_COLUMNS]`; added an empty-table test (failed before, passes after) |
| 2 | `--format=` (empty value) silently defaulted to compact instead of exit 2 | Important | Dropped the `candidate===""` fast-path → flows to `!isFormat` → exit 2; test added |
| 3 | `compactStats` emitted a stray `epic: ` line for empty `by_*` groups | Important | Skip empty groups; test asserts no stray line |
| 4–7 | type-tightening, SQLite key-order reliance, `Math.max` spread, dash-prefixed format value | Notes | Skipped — #4 resolved by #1; rest not worth changing for a controlled tool set |

### Items requiring rework
None.

### Learnings
- compact is the default and is ~80% smaller than json on multi-row lists — the per-call token win is real and measured. Claude requests `--format json` when it needs to parse a payload (note this in the T26 `CLAUDE.md` pointer/docs).
- The generic `rowsOf` + ticket-column + flat-`k=v` design covers all 22 tools with zero per-tool branches.
