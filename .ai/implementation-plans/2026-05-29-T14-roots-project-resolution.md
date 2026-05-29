# T14 — Roots-based project resolution for the global server

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Make cwd-style project auto-scoping actually work for the single global MCP server by resolving the active project from the **MCP client's roots** (the user's real workspace folders) instead of the server process's fixed `process.cwd()`.
**Architecture:** A `getClientRoots()` provider closed over `server.listRoots()` (converts `file://` roots → fs paths, returns `[]` on any failure). `requireProject` becomes async and resolves over candidate dirs = `[...clientRoots, process.cwd()]` (roots first, cwd as fallback). The provider is threaded into every tool factory via the registry; tool factories accept it as an optional param defaulting to a no-roots function so existing tests are unaffected.
**Tech Stack:** TypeScript ESM, `@modelcontextprotocol/sdk` (server `listRoots` + roots capability). No new deps.

---

## Why (the bug being fixed)

- ticketgraph is **one global stdio server** (`~/.claude/tickets.db`, spec §3) spawned once and kept alive.
- Today every tool resolves the project via `requireProject(db, {project}, process.cwd())`. For a persistent server, `process.cwd()` is the dir it was *spawned* in — it does NOT change as the user moves between projects in their Claude session.
- So cwd auto-scoping (spec §4) silently resolves to one fixed dir (or errors) regardless of where the user actually is. `project_id` is correctly a ticket attribute (composite PK `(project_id, id)`) — the *attribute* is fine; the *resolution mechanism* is broken for the global model.
- **The MCP-correct source of the user's workspace is the client's "roots"**: the client (Claude Code) advertises workspace folders; the server reads them with `server.listRoots()` → `{ roots: [{ uri: "file:///abs", name? }] }`. That tracks the user's actual session, unlike `process.cwd()`.

---

## Ticket-scoped context

- **SDK API (confirmed, v1.29):** `server.listRoots(): Promise<{ roots: { uri: string; name?: string }[] }>`. The `uri` is a `file://` URI → convert with `fileURLToPath`. If the client did NOT declare the `roots` capability, `listRoots()` rejects — catch and treat as "no roots".
- **Resolution precedence (new):**
  1. Explicit `project: "<id>"` / `"all"` → unchanged behaviour (validate, reserved-id rejection, allowAll handling).
  2. Else: candidate dirs = `[...clientRoots, process.cwd()]` (client roots take precedence; cwd is the dev/non-roots fallback). Longest-`root_path`-prefix match over registered projects, scanning candidates in order — the first candidate that yields a match wins; within a candidate, the longest matching `root_path` wins (existing `resolveProjectFromCwd` logic, applied per candidate).
  3. No match anywhere → the existing structured error, but reworded to mention roots: `"No project matches the current workspace (roots: [...], cwd: ...). Register one with tickets.register_project or pass an explicit project."`.
- **`requireProject` becomes async** because `getClientRoots()` is async. All tool `handle()` methods are already async, so callers just add `await`.
- **Minimal-churn injection**: tool factories currently are `makeXxxTool(db)`. Change to `makeXxxTool(db, getClientRoots = NO_ROOTS)` where `NO_ROOTS = async () => []`. When tests call `makeXxxTool(db)` (no provider), resolution falls back to cwd only — **identical to today's behaviour**, so existing tests pass untouched. The server passes the real provider.
- **No caching for v1**: query `listRoots()` per resolution call. It's one cheap protocol round-trip (not tokens), and per-call is always correct (no stale-roots bug when the user switches workspaces). A `roots/list_changed`-driven cache is a possible later optimisation — out of scope.
- **The server must declare it will use roots**: the SDK server doesn't need to *advertise* a capability to *call* `listRoots` (roots is a client capability). Just call it and handle rejection. Confirm against the installed SDK; if a capability flag is needed, set it in the `new Server(..., { capabilities })` options.
- **`tickets.import_json` and `tickets.register_project`** take an explicit `project` / `root_path` and never auto-resolve — they don't need the provider (but harmless to pass it).

---

## Task 1: `src/lib/roots.ts` — client-roots provider

**Files:**
- Create: `src/lib/roots.ts` + `src/lib/roots.test.ts`

**Decisions:**
- Export `type GetClientRoots = () => Promise<string[]>` and `const NO_ROOTS: GetClientRoots = async () => []`.
- Export `makeClientRootsProvider(server: { listRoots: () => Promise<{ roots: { uri: string }[] }> }): GetClientRoots` that:
  1. `await server.listRoots()`,
  2. maps each `root.uri` through `fileURLToPath` (skip/ignore non-`file:` uris),
  3. returns the resulting absolute paths,
  4. on ANY thrown error (client lacks roots capability, transport error) → returns `[]`.
- Keep it pure-ish: takes a minimal `{ listRoots }` shape so it's unit-testable with a fake.

**Don't:**
- Don't throw out of the provider — a roots failure must degrade to `[]`, never break a tool call.
- Don't `console.*` — this is server-side code (zero-console invariant).
- Don't cache yet.

**Implement:** Provider + no-roots default + tests.

**Verify:** Unit tests:
- provider returns fs paths from `file://` uris.
- non-file uris are skipped.
- `listRoots` rejection → `[]`.
- `NO_ROOTS` returns `[]`.

---

## Task 2: async `requireProject` over candidate dirs

**Files:**
- Modify: `src/lib/projects.ts`
- Modify: `src/lib/projects.test.ts`

**Decisions:**
- Add `async function requireProject(db, opts, getClientRoots: GetClientRoots): Promise<ProjectRow>`:
  - explicit-project branch unchanged (sync logic, just inside an async fn).
  - else: `const roots = await getClientRoots(); const candidates = [...roots, process.cwd()];` then for each candidate run the existing longest-prefix match (`resolveProjectFromCwd` refactored to `resolveProjectForDir(db, dir)`); return the first match.
  - no match → reworded structured error including the candidate list.
- Keep `resolveProjectFromCwd` (or rename to `resolveProjectForDir`) as the per-dir matcher; `requireProject` loops it over candidates.
- **Signature change**: the old 3rd arg was `cwd: string`; new 3rd arg is `getClientRoots`. Update all call sites (Task 3).

**Don't:**
- Don't break the explicit-project / reserved-id / allowAll semantics — only the cwd-fallback path changes.
- Don't drop the `process.cwd()` fallback — it's what makes dev (non-plugin, `claude mcp add` from a project dir) and tests still resolve.

**Implement:** Async requireProject + per-dir matcher + reworded error.

**Verify:** Unit tests (projects.test.ts):
- explicit project still resolves (and rejects reserved/unknown).
- with a fake `getClientRoots` returning a registered root path → resolves to that project even when `process.cwd()` does NOT match (THE key new test — proves roots win).
- roots empty + cwd under a registered root → resolves via cwd (fallback intact).
- no candidate matches → throws the reworded error.
- roots take precedence over cwd when both match different projects.

---

## Task 3: thread `getClientRoots` through the registry + tools

**Files:**
- Modify: `src/server.ts` (build the provider, pass into `makeToolRegistry`)
- Modify: every `src/tools/*.ts` that calls `requireProject` (next, related, blockers_of, children_of, get, search, stats, validate, changed_since, add, update, link, unlink, set_parent, append_to_description, add_tag, remove_tag)

**Decisions:**
- Factories gain an optional second param: `makeXxxTool(db: Database, getClientRoots: GetClientRoots = NO_ROOTS)`. Inside `handle`, change `requireProject(db, opts, process.cwd())` → `await requireProject(db, opts, getClientRoots)`.
- `makeToolRegistry({ db, dbPath })` becomes `({ db, dbPath, getClientRoots })`; each factory call passes `getClientRoots`. `makePingTool`/`makeRegisterProjectTool`/`makeImportJsonTool` don't resolve from cwd — leave them as-is (or pass the provider harmlessly; don't change their signatures unnecessarily).
- In `main()`: after `new Server(...)`, build `const getClientRoots = makeClientRootsProvider(server);` and pass it into `makeToolRegistry`. (Server must exist before the provider; registry is built from it — reorder if needed so the registry is created after the server.)

**Don't:**
- Don't change the signatures of tools that never call `requireProject`.
- Don't pass `process.cwd()` anywhere anymore for resolution — it's internal to `requireProject` now.
- Don't make tests pass a provider — the `NO_ROOTS` default keeps them on the cwd path (unchanged behaviour).

**Implement:** Registry + provider wiring + per-tool `await requireProject(..., getClientRoots)`.

**Verify:** `npm run typecheck` clean; existing tool tests pass unchanged (cwd fallback); the stdio/tools integration still green.

---

## Task 4: integration — roots drive resolution end-to-end

**Files:**
- Modify: `tests/server.tools.test.ts` (or a new `tests/server.roots.test.ts`)

**Decisions:**
- The existing stdio test harness (`mcp-client.ts`) is a hand-rolled JSON-RPC client that does NOT answer `roots/list` requests. To test roots end-to-end, the harness must respond to the server's `roots/list` request with a `ListRootsResult`. Add minimal support: when the client sees an incoming request with `method: "roots/list"`, reply with `{ roots: [{ uri: "file://<registered root>" }] }`.
- Test: spawn server with a temp DB; register project "demo" with `root_path = <tempProjectDir>`; configure the test client to advertise `<tempProjectDir>` as a root; call `tickets.add { title: "x" }` WITHOUT a `project` arg → it resolves to "demo" via roots (NOT the server's cwd, which is the repo root and is not a registered project). Assert the ticket lands in "demo".
- If wiring full bidirectional roots into the hand-rolled client is too heavy, fall back to a focused unit/integration test in Task 2/3 that injects a fake `getClientRoots` into a real tool against a real temp DB — proving the resolution path without the stdio round-trip. Prefer the real stdio test if feasible; document the choice.

**Don't:**
- Don't skip proving the roots path end-to-end — that's the whole point of the ticket. At minimum, a real-DB test with an injected provider.

**Implement:** Roots-driven resolution test.

**Verify:** The test fails if resolution still used `process.cwd()`; passes with roots.

---

## Task 5: docs note

**Files:**
- Modify: `docs/install.md` (a short "How project scoping works" note) OR leave for T12.

**Decisions:**
- Add a brief paragraph: ticketgraph auto-scopes to the project whose registered `root_path` contains your current workspace (resolved via MCP roots); pass `project: "<id>"` to override or `project: "all"` for cross-project reads. T12 (README/usage) will expand this — keep it short here.

**Don't:**
- Don't duplicate the full explanation in two places; a one-paragraph pointer is enough (T12 owns the usage narrative).

**Implement:** Short note.

**Verify:** Reads correctly.

---

## Task 6: Full gate

**Verify:**
1. `npm run build` → exit 0.
2. `npm test` → exit 0; all green (run twice). Existing tests unchanged (NO_ROOTS default preserves cwd behaviour); new roots tests pass.
3. `npm run typecheck` → exit 0.
4. `node dist/server.js --help` → exit 0.
5. `grep -rn 'console\.' src/ tests/` → 0 hits.

---

## Caveats & known risks

- **Per-call `listRoots` round-trip**: one extra client round-trip per resolution. Negligible (protocol message, not tokens; sub-ms locally). If it ever matters, cache + refresh on `roots/list_changed`.
- **Client without roots capability**: `listRoots()` rejects → provider returns `[]` → falls back to `process.cwd()`. So a non-roots client (or `claude mcp add` from a project dir) still works via cwd. No regression for the dev path.
- **Async requireProject ripple**: ~17 call sites gain `await`. Mechanical but must be complete — a missed `await` yields a `Promise` where a `ProjectRow` is expected (typecheck catches it).
- **Test harness roots support**: the hand-rolled `mcp-client.ts` must answer `roots/list` to test the full path. If that proves fiddly (bidirectional JSON-RPC), the injected-provider real-DB test is an acceptable substitute that still proves the resolution logic — but note which was used.
- **Server capability declaration**: confirm whether `new Server` needs any capability flag to call `listRoots`. Roots is a *client* capability; the server just calls it. If the SDK requires nothing, don't add anything.
- **`project_id` was never the problem** — it's already a ticket attribute. This ticket fixes only the *resolution* of which project the user means when they don't say.

---

## Validation review

(none at plan time — well-understood MCP feature; the only real risk is the mechanical completeness of the async ripple, which typecheck enforces, and the test-harness roots support, which has a documented fallback.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier subagent, fresh context) + direct flake remediation
**Branch:** main (unstaged at review time)

### Verification Results
- `npm run build` → exit 0.
- `npm test` → exit 0; **410/410 tests** across 42 files (was 401/41). **Verified 12/12 consecutive full-suite runs green** after the timing fixes below.
- `npm run typecheck` → exit 0 (guards the async-`await` ripple — a missed await would be a type error).
- `node dist/server.js --help` → exit 0.
- `grep -rn 'console\.' src/ tests/` → 0 hits; `grep process.cwd src/tools/` → 0 hits.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | All 21 criteria (roots provider never-throws, async requireProject, roots-precedence-over-cwd, every tool awaits with no leftover process.cwd(), NO_ROOTS default preserves old behaviour) | Completed as planned | Verified; core roots-precedence test confirmed non-vacuous |
| 2 | Used injected-provider real-DB test for the roots proof (not full bidirectional stdio roots) | Deviation | Approved — plan's documented acceptable substitute; proves the resolution logic genuinely |
| 3 | **Remaining timing flakes (shutdown 4s bound, bootstrap 5s startup-wait) under the now-42-file suite** | Deviation (BUG) | **Fixed** — shutdown 4s→12s internal / 10s→15s it; bootstrap 5s→10s wait / 10s→15s it. 12/12 green after. |
| 4 | A test named "NO_ROOTS fallback" actually used an explicit project | Nit | Fixed in-line — renamed to "explicit project resolves regardless of roots" |

### Technical Context & Learnings
- **The fix**: a global stdio server's `process.cwd()` is its spawn dir, useless for per-session project scoping. The MCP-correct source is the client's **roots** (`server.listRoots()` → `file://` URIs → fs paths). `requireProject` now resolves over `[...clientRoots, process.cwd()]` (roots first, cwd as dev/non-roots fallback). `project_id` was always a ticket attribute — only the *resolution* was wrong.
- **`makeClientRootsProvider` never throws** — a client without the roots capability makes `listRoots()` reject; the provider catches and returns `[]`, degrading to cwd. No tool call can be broken by a roots failure.
- **Minimal-churn injection**: tool factories gained `getClientRoots: GetClientRoots = NO_ROOTS`. The default means every existing test (calling `makeXxxTool(db)`) keeps cwd-only behaviour — 400+ prior tests passed untouched. Only the server wires the real provider.
- **Async ripple guarded by typecheck**: making `requireProject` async added `await` at ~17 call sites; a missed one is a compile error (Promise vs ProjectRow), so `tsc` is the completeness check.
- **Timing-flake class fully closed**: ALL spawn-based integration tests now use generous bounds tied to their vitest `it` timeout (shutdown 12s/15s, bootstrap 10s/15s, stdio 20s, tools 15s/30s) + per-child SIGKILL capture + median latency assertion. This is what makes the suite safe for CI (T13) on contended runners. **Rule: spawn-test internal SIGKILL/wait bounds must sit below — and comfortably below — the vitest it-timeout, and neither should be a tight latency benchmark.**

### Items Requiring Rework
None.

### Deferred/Skipped Items
- `roots/list_changed`-driven caching of client roots (currently queried per-resolution; correct but one round-trip per call — optimise only if it matters).
- Full bidirectional `roots/list` support in the hand-rolled stdio test client (injected-provider test covers the logic).
