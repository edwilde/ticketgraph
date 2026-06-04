# T27 — Read-path before/after: call-count and token measurement

**Date:** 2026-06-04  
**Ticket:** T27 — Cut the token cost of the "outstanding tickets" read path  
**Commits:** `ee3a0be`…`234fabd` (see `git log --oneline | grep T27`)

---

## Headline

**9 Bash calls → 1–2 calls** for the "outstanding tickets" query pattern.  
**N Bash calls → 1 call** for multi-ticket detail fetch (was one call per ticket).

---

## Scenario A — 4-ticket project, "what's outstanding?"

Session date: 2026-06-03. Real trace, verified against the code that was live at the time.

### Before (9 calls, ~3 000 tokens)

| Step | Call | Why it happened |
|------|------|-----------------|
| 1 | `list --status open` | No "outstanding" alias; model guessed narrowest status — missed `in_progress`/`blocked`/`deferred` tickets |
| 2 | `get T143 T147 T86-followup` | Tried multi-id fetch; compact format returned the same 6-column list row — description, tags, relations all invisible |
| 3 | `--help` | Model hit a wall; called help to find the right flags |
| 4 | `get --id T143 --id T147 --id T86-followup --format json` | Followed the docs; repeated `--id` silently last-wins, so only the last ticket was returned |
| 5–8 | `get T143 --format json`, `get T147 --format json`, `get T86-followup --format json`, `stats` | Fell back to one call per ticket; `stats` cross-check to find a `deferred` ticket the default `list` hides |
| 9 | (synthesis) | Assembled the picture from fragments |

**Root causes (now fixed):**  
- No `--status outstanding` alias (had to loop per-status or miss `deferred`)  
- `get` compact rendered the list row, not the detail block (description invisible)  
- Repeated `--id` silently last-wins instead of throwing  
- `--ids a b c` consumed only the first value; rest fell through as positionals → error

### After (1–2 calls)

| Goal | Call | Notes |
|------|------|-------|
| "What's outstanding with full context?" | `ticketgraph list --status outstanding --include_description --format json` | ONE call. Returns open + in_progress + blocked + deferred, with description inline. |
| "Show me these N tickets in detail" | `ticketgraph get T143 T147 T86-followup` | ONE call. Compact output is now the full detail block (description + tags + relations), not the list row. |

**Approximate token cost:** ~200–400 tokens for a 4-ticket project (single JSON response, no escalation overhead).

**Tests that prove the after-path:**

- `src/tools/list.test.ts` — `"status: 'outstanding' includes deferred and excludes done"` (line 102) and `"status: 'outstanding' is a superset of the default filter"` (line 122): assert the alias returns the correct superset.
- `src/cli/format.test.ts` — `"compact get: single {ticket} renders a detail block (not the 6-col row)"` (line 197) and `"get compact shows description, tags and relations"` (line 205): assert the compact output is a multi-line detail block, not a list row.
- `src/cli/flags.test.ts` — `"--ids T1 T2 T3 (array-typed prop) → consumes the run"` (line 69): proves `--ids a b c` now folds the whole run into the ids array. `"repeated --id (plain scalar) throws a clear error"` (line 112): proves repeated `--id` fails loudly instead of silently dropping ids.
- `tests/cli.spawn.test.ts` — `"get <id1> <id2> <id3> --project cli_spawn (multiple positionals) → exit 0, returns all three tickets as a batch"` (line 291): end-to-end spawn proof that three positional ids return three tickets.

---

## Scenario B — Empty board (152/155 done, 3 blocked/deferred)

Session date: 2026-06-04. Real trace against a live project.

### Before (multi-call escalation)

| Step | Call | Why it happened |
|------|------|-----------------|
| 1 | `next` | Returned `ticket: -` / `reason: -` — model couldn't distinguish "board clear" from "tool error / bad call" |
| 2 | `list --status all \| grep -vi done` | No "outstanding" alias; fragile grep on the word "done" |
| 3–6 | `list --status blocked`, `list --status deferred`, `list --status in_progress`, `list --status open` | Per-status loop to reconstruct the board |
| 7+ | `get ... --format json` (per ticket) | `--ids a b c` consumed only the first value; rest fell through → error → one call per ticket |

**Root causes (now fixed):**  
- `next` returned blank with no explanation on an empty board  
- No single "not-done" view; `--status all` drowned the 3 outstanding in 152 done rows  
- `--ids a b c` array-flag parsing broken (covered in Scenario A)

### After (1–2 calls)

| Goal | Call | Notes |
|------|------|-------|
| "Is there anything outstanding at all?" | `ticketgraph next` | Read `message` field. Now returns e.g. "nothing ready to work on — 2 blocked, 1 deferred; run `list --status outstanding` to see them." ONE call, machine-readable. |
| "Show me what's left" | `ticketgraph list --status outstanding` | ONE call. Returns the 3 non-done tickets only, no done noise. |

**Tests that prove the after-path:**

- `src/tools/next.test.ts` — `"empty board (blocked + in_progress + deferred, no open) returns a message..."` (line 167): seeds a board with no open tickets, asserts `result.message` contains "nothing ready", "deferred", and "outstanding" — machine-readable signal that the board has no actionable work.
- `src/tools/next.test.ts` — `"truly empty project returns a clean-board message"` (line 188) and `"empty message stays within a small byte budget"` (line 199): cover the all-done and zero-ticket cases.
- `src/tools/list.test.ts` — `"status: 'outstanding' includes deferred and excludes done"` (line 102): same test as Scenario A — proves the single-call "not-done" view exists.

---

## Won't-do: P3 compact title truncation

The ticket scoped a P3 item: widen the 60-char title truncation in `format.ts:27` (or note `--format table`).

**Decision: won't do.** The P1 fixes already remove the need:
- `get` compact now renders the full ticket body — the description is verbatim and unbounded, so a 60-char title cap no longer causes loss of critical information.
- When title length matters (multi-row `list` views), `--format table` is the right tool and is already documented.
- Widening every `list` row's title would inflate token cost on every list call, counter to T27's mission.

Recording this explicitly so the decision isn't relitigated.

---

## Summary

| Scenario | Before | After |
|----------|--------|-------|
| 4-ticket "outstanding" read | ~9 calls, ~3 000 tokens | 1–2 calls, ~200–400 tokens |
| Empty-board "is anything left?" | multi-call escalation (grep + per-status loop) | 1 call (`next` reads `message`) |
| N-ticket detail fetch | N calls (one per ticket, after --id failure) | 1 call (`get T1 T2 T3`) |
