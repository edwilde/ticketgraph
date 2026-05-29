# T17 — demo parser fidelity enhancements

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Improve the demo parser's fidelity on two high-value, high-precision axes — infer `type=spike` from `Spike:` titles, and emit `follows_up` relations from explicit shipped-note phrasings ("follow-up tickets filed: T…", "Spawned T…-T… follow-ups"). Two other proposed axes are deliberately **won't-do** (documented below).
**Architecture:** Pure-function changes to `src/parsers/demo.ts` only; new committed fixtures + tests in `tests/fixtures/demo/` and `src/parsers/demo.test.ts`. No tool/server changes, no schema changes.
**Tech Stack:** TypeScript ESM. No new deps.

---

## Ticket-scoped context (READ — scope was narrowed against real data)

- **The live demo `TICKETS.md` is already migrated and DELETED** (a prior session ran the live import per spec §7 and removed the source). So: (a) these improvements can't be re-calibrated against the live file; (b) they benefit a *future* re-import (the source would have to be recovered from the demo repo's git history, then `import_json({ force: true })`) or other demo-format projects; (c) **all testing is against the committed fixtures in `tests/fixtures/demo/`** — which is the version-controlled contract anyway (spec §16).
- **Grounding came from the fixtures** (the live file is gone). Relevant shapes:
  - `16-umbrella-spawned.md` status: `✅ Done 2026-05-26. … Eight follow-up tickets filed: T112 (BaseCommand consolidation P1), T113 (…), …` — explicit follow-up listing.
  - `20-range-expansion.md` status: `✅ Done 2026-05-26. Spawned T112-T115 follow-ups.` — range form (the existing `expandRanges` already turns `T112-T115` into `T112, T113, T114, T115` text, but no relation is emitted today).
  - `01-done-with-commit.md`: `✅ Done — commit …` (no date → null `closed_at`, correctly).
- **Two items are WON'T-DO (decided, with reasons):**
  1. **Body-level priority override** — REJECTED. Spec §7 makes the `## P<n> — Name` section heading the canonical priority. The "P1" the feedback saw (e.g. T112 imported as P3) appears as `T112 (BaseCommand consolidation P1)` *inside another ticket's* shipped notes — it describes a *different* ticket, not a priority declaration for the host ticket. There is no structured per-ticket priority field in the demo format to key off. Treating prose "P1" as a priority is a false-positive magnet and contradicts the spec. Leave priority = section heading.
  3. **`closed_at` from a separate narrative paragraph** — REJECTED (low value now). The per-ticket Status-line date parse already captures the dates that exist (`✅ Done 2026-05-26` → caught). Tickets with no date anywhere (`✅ Done — commit …`) have nothing to parse. The only extra source is the cross-ticket "Shipped (full list)" paragraph at the top of the file — a fiddly per-ticket-date association — and the live file is gone, so there's nothing to re-import-with-dates against. Not worth the parsing risk. (If a future need arises, reopen.)
- **Direction convention (spec §5)**: `from follows_up to` → `from` is the follow-up, `to` is the predecessor. So for "ticket X's notes list follow-ups T112, T113", each child `follows_up` X: `{ from: T112, to: X, kind: "follows_up" }`.
- **Precision-first**: the plan's standing rule is "over-emitting noisy relations is worse than missing a few." Anchor on the specific phrases; do NOT match a bare "follow-up" mention.
- **Umbrella vs follows_up note**: spec §5 models the T103→T112-T119 umbrella as `parent_id` (hierarchy), while §7 says shipped-note follow-up *mentions* → `follows_up` relations. These overlap in the file. This ticket implements the §7 `follows_up`-relation reading (what the feedback asked for); it does NOT attempt `parent_id` inference from prose (ambiguous; out of scope, noted as possible future work).

---

## Task 1: type inference — `Spike:` → `type: "spike"`

**Files:**
- Modify: `src/parsers/demo.ts`
- Create: `tests/fixtures/demo/21-spike-type.md`
- Modify: `src/parsers/demo.test.ts`

**Decisions:**
- After parsing the `title`, set `type = "spike"` when the title matches `/^Spike\b/i` or starts with `Spike:` (the real demo T3 was "Spike: verify deploy log poll endpoint shape"). Otherwise leave `type` unset (defaults to `task` per import-format / §5).
- Only this one high-precision signal. Do NOT attempt `bug` inference (no reliable keyword in demo's `T<n>` tickets).
- `ImportTicket.type` is optional; set it only for spikes.

**Don't:**
- Don't infer `bug`/`umbrella`/etc. — no reliable signal; would risk mislabeling.
- Don't match "spike" mid-title loosely — anchor at the title start (`^Spike`).

**Implement:** Add the type assignment; add a `21-spike-type.md` fixture (a `### T3 — Spike: …` shape, real-style) + a test asserting `type === "spike"`, plus a test that a normal ticket has no `type` (defaults to task on import).

**Verify:** `npm test src/parsers/demo.test.ts` green; the spike fixture asserts `type: "spike"`.

---

## Task 2: prose-implied `follows_up` relations

**Files:**
- Modify: `src/parsers/demo.ts`
- Modify: `src/parsers/demo.test.ts` (use existing fixtures 16 + 20; add assertions)

**Decisions:**
- In pass 2 (relation resolution), scan each ticket's `_rawStatusLine` (the shipped-note text already captured) for two high-precision phrasings, and for each listed child `T<n>` emit `{ from: child, to: ticket.id, kind: "follows_up" }`:
  1. **"follow-up tickets filed: T<a> …, T<b> …"** — match the anchor `follow-up tickets filed:` (case-insensitive), then extract all `T\d+` refs from the remainder of that clause.
  2. **"Spawned T<a>-T<b> follow-ups"** / **"Spawned T<a>, T<b> follow-ups"** — match the anchor `Spawned …  follow-ups`; since `expandRanges` already expanded `T112-T115` to `T112, T113, T114, T115` in the text, extract all `T\d+` refs from between "Spawned" and "follow-ups".
- Reuse `extractTicketRefs` for the ref extraction within the matched clause.
- Dedup against the existing relation set (the `relMap` already dedups by `from|to|kind`) — a child already linked via `Tracked as` won't double-up.
- Do NOT emit a `follows_up` from the host ticket to itself; skip any ref equal to `ticket.id`.

**Don't:**
- Don't match a bare "follow-up" / "follows up" without the specific anchor (precision).
- Don't change the `Blockers:`/`superseded by`/`Tracked as` logic — only ADD the two new anchored patterns.
- Don't infer `parent_id` from these phrasings (out of scope; ambiguous).
- Don't lower the precision bar to catch more — missing a few is acceptable; false edges are not.

**Implement:** Add the two anchored extractors in pass 2; emit deduped `follows_up` relations.

**Verify:** Tests against fixtures 16 + 20:
- Fixture 16 ("Eight follow-up tickets filed: T112 …, T113 …, …") → `follows_up` relations `{from: T112, to: <host>}`, `{from: T113, to: <host>}`, … for each listed child.
- Fixture 20 ("Spawned T112-T115 follow-ups") → `follows_up` for T112, T113, T114, T115 → host.
- A ticket with no such phrasing → no spurious `follows_up`.
- No self-relation; no duplicates.

---

## Task 3: calibration note + won't-do record

**Files:**
- Modify: `src/parsers/demo.ts` (a short comment block documenting the won't-do decisions for items 1 + 3, so a future reader knows they were considered and why rejected).

**Decisions:**
- A concise comment near the priority assignment: "Priority is section-heading-canonical (spec §7); body 'P<n>' mentions describe OTHER tickets and are NOT treated as priority — see T17 review record."
- A concise comment near `parseShipDate`: "closed_at is parsed from the per-ticket Status line only; the cross-ticket 'Shipped (full list)' narrative paragraph is intentionally not mined (T17)."

**Don't:**
- Don't leave the rejected items undocumented — a future contributor will otherwise re-litigate them.

**Implement:** Two short comments.

**Verify:** Comments present; build clean.

---

## Task 4: Full gate

**Verify:**
1. `npm run build` → exit 0 (parser still builds to `dist/parsers/demo.js`).
2. `npm test` → exit 0; all green (existing 22 fixtures + new spike fixture + new assertions). Run twice (suite is timing-stable; don't touch the spawn-test bounds).
3. `npm run typecheck` → exit 0.
4. `node dist/server.js --help` → exit 0.
5. `grep -rn 'console\.' src/ tests/` → 0 hits (the parser CLI uses `process.stdout/stderr.write`).
6. Sanity: run the CLI on fixture 16 (`node dist/parsers/demo.js tests/fixtures/demo/16-umbrella-spawned.md`) and confirm the JSON now contains the `follows_up` relations.

---

## Caveats & known risks

- **Live demo already migrated + deleted**: these improvements do not retroactively fix the already-imported data. To benefit, recover the source from the demo repo's git history and `import_json({ force: true })`, or apply to other demo-format projects. The improvements are still correct and worth having in the parser.
- **Precision over recall**: the two new anchors are deliberately narrow. Some genuine follow-up mentions phrased differently won't be caught — acceptable per the standing rule.
- **Direction**: child `follows_up` host (child is the follow-up, host is the predecessor) per spec §5. Getting this backwards would make `tickets.related`/`blockers_of` misreport — the tests assert the exact `from`/`to`.
- **Umbrella/parent_id not inferred**: the same phrasings arguably also imply `parent_id` (spec §5's T103→T112-T119 example). This ticket intentionally only does the §7 `follows_up`-relation reading; prose→parent_id is ambiguous and out of scope.
- **Won't-do items are decisions, not omissions**: items 1 (body priority) and 3 (narrative closed_at) are recorded as rejected with reasons in the parser comments and the review record, so they aren't silently re-attempted.

---

## Validation review

(none — pure-function parser changes with fixture tests; the only judgement is the precision of the two new anchors, covered by tests + the explicit won't-do record.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier subagent, fresh context)
**Branch:** feat/t16-t17-post-v0.1.0

### Verification Results
- `npm run build` → 0. `npm test` → 0; **425/425** (was 414; +11). `npm run typecheck` → 0. `--help` → 0. `grep console.` → 0.
- Runtime sanity: fixture 16 → 8 `follows_up` (T112–T119 → T103); fixture 20 → 4 (T112–T115 → T103); fixture 23 → T3=spike, T4=task; fixture 01 ("deferred follow-ups" prose) → **0 spurious** follows_up.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | Spike→type inference + 2 anchored follows_up patterns (all 15 criteria) | Completed as planned | Verified |
| 2 | Direction child→host (`from: child, to: host`) correct | Completed as planned | Verified at runtime |
| 3 | Precision: bare "follow-up" prose does NOT fire (fixture 01 → 0) | Completed as planned | Runtime false-positive test confirms |
| 4 | Won't-do items 1 (body priority) + 3 (narrative closed_at) documented, NOT implemented | Completed as planned | Both comments present; features verified absent at runtime |
| 5 | Fixture numbered 23 (not 21 — `21-blocked-status.md` already existed) | Deviation (cosmetic) | Approved |

### Technical Context & Learnings
- **Two high-precision anchors only**: `follow-up tickets filed:` (colon mandatory) and `Spawned … follow-ups`. A bare "follow-up"/"deferred follow-ups" mention does NOT trigger a relation — verified by a runtime test against fixture 01. Precision-first per the standing rule.
- **`expandRanges` runs before per-ticket status parsing**, so "Spawned T112-T115 follow-ups" already has the range expanded to individual refs when the anchor regex matches — critical ordering.
- **Direction**: child `follows_up` host (child is the follow-up, host the predecessor — spec §5). The umbrella host (e.g. T103) is the `to`; the spawned children are the `from`. Getting this backwards would make `tickets.related`/`blockers_of` misreport.
- **Won't-do decisions are in-code comments** (priority = section-heading-canonical; closed_at = Status-line only) so they aren't silently re-litigated.
- **Live-file caveat**: demo was already migrated + the source deleted, so these gains apply to a future re-import (recover source from git history → `import_json({force:true})`) or other demo-format projects. Tests are fixture-based (the version-controlled contract).

### Items Requiring Rework
None.

### Deferred/Skipped Items (deliberate won't-do)
- Body-level priority override (spec §7 section-heading canonical; prose "P<n>" describes other tickets).
- closed_at from cross-ticket narrative paragraph (Status-line dates already captured; live file gone).
- prose→parent_id inference (ambiguous vs follows_up; out of scope).
