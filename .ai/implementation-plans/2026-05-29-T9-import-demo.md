# T9 — Migration tool (`tickets.import_json`) + demo parser

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Ship the generic JSON-intermediate importer (`tickets.import_json`) and the demo-specific parser that produces that intermediate, so demo's 4,127-line `TICKETS.md` migrates into the store with ≥95% fidelity.
**Architecture:** A shared TypeScript type for the JSON intermediate (`src/lib/import-format.ts`). The `tickets.import_json` MCP tool consumes it (3-pass transactional write, dry-run, force). A pure `parseDemo(md): ImportFile` function in `src/parsers/demo.ts` plus a thin CLI entry. Format doc in `docs/import-format.md`. Tests use version-controlled fixtures (spec §16), never the live file.
**Tech Stack:** TypeScript ESM, better-sqlite3. No new deps (Node's `fs` for the CLI).

---

## Ticket-scoped context

- **Two halves**: (a) the generic `tickets.import_json` ingester — project-agnostic; (b) the demo parser — format-specific. They meet at the JSON intermediate (spec §7).
- **JSON intermediate** (spec §7), exact shape:
  ```json
  {
    "project_id": "demo",
    "tickets": [{ "id", "title", "description", "status", "priority", "type",
                  "effort", "epic", "parent_id", "created_by", "created_at",
                  "closed_at", "tags": [] }],
    "relations": [{ "from", "to", "kind", "note" }]
  }
  ```
- **import_json contract** (spec §7):
  - `project_id` in the file must match the `project` arg AND an already-registered project. Abort otherwise.
  - **3-pass write inside ONE transaction**: (1) insert tickets with `parent_id` blanked, (2) `UPDATE parent_id` once all rows exist, (3) insert relations. Tags inserted in pass 1 alongside their ticket. Forward references inside the file are therefore safe.
  - Missing fields default per §5 (`status`→open, `type`→task, `effort`/`priority`/`epic`/`parent_id`→null, `description`→"").
  - `created_at` honoured if supplied, else import time (`nowIso()`).
  - **Audit on live import**: every inserted ticket gets a `_created` row stamped with `changed_at = created_at` (so `changed_since` tells the truth for back-dated history).
  - `dry_run: true` → validate + return `{ counts: { tickets, relations, tags }, warnings: [] }`, NO mutation.
  - Duplicates: `(project_id, id)` collisions → listed in `warnings` and ABORT the live import unless `force: true`. (With `force`, overwrite? Spec §6 says "Refuses to overwrite existing rows unless force: true" — so `force` permits overwrite via `INSERT OR REPLACE` OR delete-then-insert. **Decision:** with `force`, `DELETE` the colliding ticket first (cascades relations/tags) then insert fresh — cleaner than REPLACE and keeps audit honest with a new `_created`.)
  - Relations referencing ticket ids not present (in the file OR already in the DB) → warning; skip that relation, don't abort (a dangling cross-reference shouldn't sink the whole import).
- **demo parser heuristics** (spec §7, calibrated against the real `~/Scripts/demo/.ai/TICKETS.md`):
  - `### T<n> — <title>` heading → `id` (`T<n>`) + `title`. Titles may contain backticks/punctuation — take everything after the em-dash `— `.
  - `**Status:**` line: presence of `✅ Done` (or `Done`) → `status=done`. Absence of a Status line → `status=open` (most open tickets in demo just omit it). Other markers if present: `In progress` → in_progress; `Deferred` → deferred; `Blocked` → blocked.
  - `closed_at`: parse an inline date in the Status/ship-notes (`shipped 2026-05-27`, `landed 2026-05-26`) → normalise to `2026-05-27T00:00:00.000Z`. If none parseable but status=done, leave `closed_at` null (legal per §7).
  - `**Blockers:** T2, T5` or `T2 + a real account` → relations of kind `blocks` (second pass). Extract `T\d+` tokens; ignore prose. `none` → no relations.
  - `**Scope:** ... **Acceptance:** ...` → concatenated into `description` (keep the `**Scope:**`/`**Acceptance:**` labels as section markers in the body).
  - `## P<n> — <name>` section heading → `priority` (`P0`..`P3`) for all tickets under it + `epic` = the name after the em-dash ("Foundation", "Auth + linking", "Deploy core").
  - The narrative "Shipped (full list)" / status-table paragraph → supplementary `status=done` confirmation + ship-notes appended to description; follow-up/supersedes mentions ("Tracked as T60", "T41 superseded by T70", "spawned T112-T119") → relations of kind `follows_up` / `supersedes`. **Scope these conservatively**: only emit a relation when the pattern is unambiguous (`superseded by T<n>` → supersedes; `Tracked as T<n>`/`follow-up ... T<n>` → follows_up). Over-emitting noisy relations is worse than missing a few; log skipped ambiguous mentions to the `--report`.
  - `created_by` → `"migrated:demo"` (spec §7).
  - Commit refs (`commit 20d91af`) → preserved verbatim in `description`, NOT a structured field.
- **Parser is a PURE function** `parseDemo(md: string): ImportFile` — no file I/O inside. The CLI wrapper reads stdin/argv and writes stdout. This keeps it unit-testable against fixture strings.
- **Two-pass parsing**: pass 1 builds all tickets (so ids exist); pass 2 resolves blocker/follow-up/supersedes references into relations. Forward refs are fine.
- **Tests use fixtures, NEVER the live file** (spec §16): `tests/fixtures/demo/*.md` holding the 20 most-distinctive ticket shapes. The ≥95% round-trip acceptance is measured by running the parser over the real file via the CLI (a manual/acceptance step), but the committed tests run on fixtures.
- **`--report` flag** on the CLI: emits a summary of parsed counts + skipped/ambiguous lines to stderr, so manual fixups are discoverable (spec T9 acceptance).

---

## Task 1: `src/lib/import-format.ts` + `docs/import-format.md`

**Files:**
- Create: `src/lib/import-format.ts`
- Create: `docs/import-format.md`

**Decisions:**
- `import-format.ts` exports the `ImportFile`, `ImportTicket`, `ImportRelation` TypeScript interfaces matching spec §7, plus a `validateImportFile(raw: unknown): ImportFile` runtime guard that throws descriptive errors (used by both `import_json` and parser tests). Validate: `project_id` string; `tickets` array; each ticket has a string `id` + `title`; optional fields are the right type when present; `status`/`type`/`priority`/`effort` within their allowed sets when present; `relations` array with from/to/kind strings.
- `docs/import-format.md` documents the schema (table of fields, types, defaults, the 3-pass semantics, dry-run, force, audit back-dating) — this is the spec §7 contract in user-facing form. (T12 links to it.)

**Don't:**
- Don't duplicate the validation in both tool and parser — both import `validateImportFile`.
- Don't accept `created_at`/`closed_at` formats other than ISO 8601.

**Implement:** Types + validator + doc.

**Verify:** Unit tests for `validateImportFile`: valid file passes; missing project_id throws; bad effort value throws; non-array tickets throws.

---

## Task 2: `tickets.import_json`

**Files:**
- Create: `src/tools/import_json.ts` + `src/tools/import_json.test.ts`

**Decisions:**
- Factory `makeImportJsonTool(db)`.
- Args: `{ project: string, file: string, dry_run?: boolean, force?: boolean }`. (Note `project` is required here — import is explicit; no cwd resolution.)
- handle:
  1. Validate `project` is registered (else InvalidParams).
  2. Read `file` from disk (`readFileSync`); JSON.parse; `validateImportFile`.
  3. Assert `parsed.project_id === project` (else InvalidParams "file is for project X, not Y").
  4. Compute warnings: duplicate `(project_id, id)` vs existing DB rows; relations whose endpoints aren't in (file ids ∪ DB ids).
  5. If `dry_run`: return `{ counts: { tickets, relations, tags }, warnings }`. No mutation.
  6. If not dry_run and duplicates exist and `!force`: throw `McpError(InvalidParams, ...)` listing the colliding ids.
  7. Else, in ONE transaction:
     - For `force` collisions: `DELETE FROM tickets WHERE project_id=? AND id=?` (cascade clears its relations/tags).
     - Pass 1: insert every ticket with `parent_id = NULL`; insert its tags; write `_created` audit (`changed_at = created_at`).
     - Pass 2: `UPDATE tickets SET parent_id = ?` for tickets that had a parent.
     - Pass 3: insert relations whose endpoints exist (skip+warn otherwise); each relation writes its `relation:<kind>` audit row.
  8. Return `{ imported: true, counts, warnings }`.

**Don't:**
- Don't mutate on `dry_run`.
- Don't abort the whole import for a single dangling relation — skip+warn.
- Don't write `_created` with `nowIso()` when the ticket carries a `created_at` — back-date it (spec §7).
- Don't run the three passes in separate transactions — one transaction, all-or-nothing.

**Implement:** Tool.

**Verify:** Unit tests:
- dry_run returns counts + warnings, DB unchanged.
- live import inserts tickets, tags, relations; `_created` audit back-dated to created_at.
- forward parent reference resolves (child before parent in file).
- duplicate without force → aborts with InvalidParams.
- duplicate with force → overwrites cleanly.
- dangling relation → skipped + warned, rest imported.
- project mismatch → InvalidParams.
- missing fields default per §5.

---

## Task 3: demo parser — core (`parseDemo`)

**Files:**
- Create: `src/parsers/demo.ts`
- Create: `tests/fixtures/demo/*.md` (≥20 distinctive shapes)
- Create: `src/parsers/demo.test.ts`

**Decisions:**
- Export pure `parseDemo(md: string): ImportFile` with `project_id: "demo"`.
- Implement the §7 heuristics above. Structure: split into `## ` sections (capture priority + epic), then within each, split into `### T<n>` ticket blocks. Parse Status / Blockers / Scope / Acceptance per block.
- Second pass over all blocks' Status/ship-note text for `superseded by T<n>` / `Tracked as T<n>` / `follow-up ... T<n>` → supersedes/follows_up relations.
- Fixtures: capture the 20 most-distinctive real shapes (done-with-commit, open-no-status, blockers-with-prose, multi-line-scope, superseded, follow-up-spawned, umbrella T103→T112-T119, deferred, in-progress). Copy representative blocks from the real file into `tests/fixtures/demo/` — trim to the distinctive shape, keep it real.

**Don't:**
- Don't do file I/O in `parseDemo` — pure string→object.
- Don't over-emit relations from ambiguous prose — conservative matching only.
- Don't read the live `~/Scripts/demo/.ai/TICKETS.md` in any test.

**Implement:** Parser + fixtures + tests.

**Verify:** Unit tests (one per fixture shape, ≥20 total):
- T<n> heading → id + title (incl. backticked titles).
- Status ✅ Done → done; absent → open; Deferred/In progress.
- Blockers `T2, T5` → two `blocks` relations; `none` → none; prose-mixed extracts only T-refs.
- Scope+Acceptance concatenated into description.
- `## P1 — Auth + linking` → priority P1, epic "Auth + linking" for its tickets.
- `superseded by T70` → supersedes relation; `Tracked as T60` → follows_up.
- created_by = "migrated:demo".
- inline ship date → closed_at normalised; no date + done → closed_at null.

---

## Task 4: demo parser — CLI entry

**Files:**
- Modify: `tsup.config.ts` (add `src/parsers/demo.ts` as a second entry so it builds to `dist/parsers/demo.js`)
- Modify: `src/parsers/demo.ts` (add a CLI guard)

**Decisions:**
- CLI: `node dist/parsers/demo.js <input.md> [--report]` reads the file, runs `parseDemo`, writes JSON to stdout. `--report` writes a parse summary (ticket count, relation count by kind, skipped/ambiguous lines) to stderr.
- Guard the CLI with `if (import.meta.url === pathToFileURL(process.argv[1]).href)` so importing the module for tests doesn't trigger the CLI.
- tsup: change `entry` to `["src/server.ts", "src/parsers/demo.ts"]` so both build. Confirm `dist/parsers/demo.js` is produced and is executable-ish (it's run via `node`, no shebang needed, but harmless to add one).

**Don't:**
- Don't make the CLI the only interface — `parseDemo` stays independently importable/testable.
- Don't break the existing `dist/server.js` build or its shebang banner when adding the second entry.

**Implement:** CLI wrapper + build config.

**Verify:** `npm run build` produces `dist/parsers/demo.js`. Running it on a fixture file emits valid JSON parseable by `validateImportFile`.

---

## Task 5: Wire import_json into registry + acceptance

**Files:**
- Modify: `src/server.ts` — register `makeImportJsonTool` (registry → 21 tools).
- Modify: `tests/server.tools.test.ts` — count assertion → 21. (No full import in E2E — covered by unit tests; just assert the tool is listed.)

**Decisions:**
- Registry adds import_json. Update the count.
- The ≥95% round-trip acceptance against the REAL demo file is a MANUAL step (not a committed test, since tests can't read the live file). Document the command in `docs/import-format.md`: `node dist/parsers/demo.js ~/Scripts/demo/.ai/TICKETS.md --report > /tmp/demo.json` then eyeball + `tickets.import_json({ dry_run: true })`.

**Don't:**
- Don't add a committed test that reads the live demo file.

**Implement:** Registry + count + doc note.

**Verify:** `tools/list` returns 21.

---

## Task 6: Manual round-trip calibration (acceptance evidence)

**Files:** (none — produces evidence, not committed code)

**Decisions:**
- Run the parser over the real `~/Scripts/demo/.ai/TICKETS.md`, capture the `--report` output, and record the round-trip fidelity (parsed tickets / 133 headings) in the review record. Target ≥95% (≥127 of 133).
- Do NOT perform a live import into `~/.claude/tickets.db` in this ticket — migration execution is a separate, deliberate step (spec §7 flow). T9 proves the parser + dry-run path work.

**Implement:** Run, capture, record numbers.

**Verify:** Report shows ≥95% of the 133 `### T<n>` headings parsed into tickets with id+title+status; relation extraction count is sane (not wildly over-emitting).

---

## Task 7: Full gate

**Verify:**
1. `npm run build` → exit 0; `dist/server.js` + `dist/parsers/demo.js` both exist.
2. `npm test` → exit 0; all green.
3. `npm run typecheck` → exit 0.
4. `node dist/server.js --help` → exit 0.
5. `grep -rn 'console\.' src/ tests/` → 0 hits **EXCEPT** the demo CLI entry, which legitimately writes to stdout/stderr. **Decision:** the CLI must use `process.stdout.write` / `process.stderr.write`, NOT `console.*`, to keep the grep invariant intact. (The server's stdout-sacredness doesn't apply to a standalone CLI, but keeping the zero-console rule uniform avoids a special case.)

---

## Caveats & known risks

- **demo format drift**: the parser is calibrated to the file as it exists today. The live file changes; that's exactly why tests use frozen fixtures (spec §16). The ≥95% metric is a point-in-time acceptance, not a standing test.
- **Relation over-emission**: ambiguous prose ("spawned T112-T119 follow-ups") is a range, not a single ref. Decide: expand `T112-T119` into individual follows_up relations, or skip and report. **Decision:** expand explicit numeric ranges (`T112-T119` → T112..T119) since the pattern is unambiguous; report anything fuzzier.
- **Umbrella detection**: T103→T112-T119 is a parent/child via `parent_id`, not a relation. The parser should set `parent_id` on the children when an umbrella relationship is explicit ("spawned ... follow-ups"). If detection is unreliable, leave `parent_id` null and report — a missed parent is a `tickets.set_parent` away post-import.
- **dry_run is the safety net**: the migration flow (spec §7) is dry-run → eyeball → live. T9 never auto-runs a live import against the real DB.
- **`force` deletes before insert**: cascades remove the ticket's existing relations/tags. That's intended for re-import, but destructive — only reachable with the explicit flag.
- **CLI console rule**: standalone parser CLI uses `process.stdout/stderr.write`, not `console.*`, so the zero-console grep stays a clean invariant across the whole repo.
- **Second tsup entry**: adding `src/parsers/demo.ts` must not regress the server bundle or its shebang. Verify both outputs after the config change.

---

## Validation review

(none at plan time — but this is the highest-uncertainty ticket. If the parser's real-file round-trip lands materially below 95% during Task 6, that's a signal to revisit heuristics before closing, not to lower the bar.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier subagent, fresh context) + direct root-cause debugging of a flaky test
**Branch:** main (unstaged at review time)

### Verification Results
- `npm run build` → exit 0; `dist/server.js` + `dist/parsers/demo.js` both produced; shebang intact.
- `npm test` → exit 0; **350/350 tests** across 39 files (was 258/36). **Verified stable: 8/8 consecutive full-suite runs green** after the flake fix.
- `npm run typecheck` → exit 0.
- `node dist/server.js --help` → exit 0.
- `grep -rn 'console\.' src/ tests/` → 0 hits.
- Calibration re-run on real demo file confirmed: **133/133 headings parsed (100%)**, relations blocks=113, follows_up=1, supersedes=1, 0 skipped.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | All T9 spec criteria (3-pass single transaction, dry_run no-mutate, force delete+insert, back-dated _created audit, closed_at from JSON, dangling-skip, project match, parser heuristics, fixture-only tests) | Completed as planned | Verified by the reviewer with code + test evidence |
| 2 | demo heading regex broadened to `T\d+[\w-]*` for 13 real suffixed ids (T50a, T49-followup) | Deviation | Approved — within "calibrated against the real file" intent; 120 base + 13 suffixed = 133 |
| 3 | **Flaky integration tests: ~1 in 3 full-suite runs failed with "Server closed (code=null)"** | Deviation (BUG, pre-existing from T2) | **Fixed** — root-caused to a cross-test SIGKILL-timer bug (see below); 8/8 runs green after fix |
| 4 | `validateImportFile` doesn't validate `created_by` is a string | Nit | Deferred — no DB constraint; harmless |
| 5 | Relation audit rows use `nowIso()` not a back-dated time | Nit | Deferred — relations have no independent timestamp in the file format; reasonable |

### Technical Context & Learnings
- **THE FLAKE (important, would have red-failed CI):** `server.stdio.test.ts` and `server.tools.test.ts` keep the spawned server in a module-level `let child`. Their `afterEach` SIGTERM'd the child and set a 1s SIGKILL-fallback `setTimeout` whose closure read the **module-level `child`**. Under parallel load (39 files), a slow-to-die child left its SIGKILL timer pending; the next test reassigned `child` to a fresh server, and the stale timer then **SIGKILLed the next test's server before it logged anything** (`code=null`, empty stderr). Fix: capture the child in a local `const c = child` so the timer can only ever kill its own process. Latent since T2; only surfaced once enough parallel files existed to make SIGTERM cleanup lag.
- **Hardening added alongside the fix:** `waitForServerReady(child)` (waits for the "ticketgraph starting" stderr line before the handshake) + request timeout bumped 5s→15s. These remove the cold-start race deterministically and tolerate loaded-CI slowness. The readiness helper lives in `tests/helpers/mcp-client.ts`.
- **import_json 3-pass is one transaction**: insert (parent_id NULL) + tags + back-dated `_created` audit → UPDATE parent_id → insert relations (skip+warn on dangling). All-or-nothing.
- **closed_at on import**: the `tickets_closed_at_set` trigger only fires on status UPDATE, not INSERT, so the importer writes `closed_at` explicitly from the JSON via a post-insert UPDATE for done tickets that carry a date. Done tickets with null closed_at stay null (legal §7).
- **Parser purity**: `parseDemo(md)` is pure string→ImportFile; the CLI (`dist/parsers/demo.js`, second tsup entry) is the only I/O, guarded by an `import.meta.url` check and using `process.stdout/stderr.write` (not console) to keep the repo-wide zero-console invariant.
- **Migration execution deferred**: T9 proves parser + dry-run. A live import into `~/.claude/tickets.db` is a separate deliberate step (spec §7 flow) — NOT done in this ticket.

### Items Requiring Rework
None.

### Deferred/Skipped Items
- Live demo import into the real DB (deliberate separate step).
- `created_by` string validation in `validateImportFile`; relation audit back-dating (both nits).
