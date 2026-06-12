# T28 — `ticketgraph mcp` command + CLI-first README — Implementation Plan

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task. TDD where a unit/spawn test fits.

**Goal:** Add a friendly `ticketgraph mcp` command to start the MCP stdio server (additive — `--mcp`/no-args keep working), restructure the README to lead with the CLI, and ship it as v0.6.0 with a GitHub release.
**Architecture:** `server.js` is a dual-mode entry: the entry switch (`server.ts:109-110`) picks server-mode vs CLI from `argv[0]`; server-mode calls `main()` (stdio MCP), CLI-mode calls `runCli()`. CLI commands are derived from the tool registry — but starting the server is a *mode*, not a tool, so `mcp` belongs in the entry switch, never the registry/catalogue.
**Tech Stack:** TypeScript ESM, better-sqlite3, MCP SDK (stdio), vitest, tsup.

---

## Ticket-scoped context

- **Entry switch is the only behavioural change.** `server.ts:110`: `const serverMode = argv.length === 0 || argv[0] === "--mcp";` → add `|| argv[0] === "mcp"`. `main()` already logs `"ticketgraph starting"` (`server.ts:83`) and connects stdio — nothing downstream changes.
- **Additive, not a replacement.** Bare-invocation and `--mcp` MUST keep booting the server — existing MCP client configs and `docs/install.md` registration depend on them. `mcp` is just the documented-preferred form.
- **`mcp` must not reach `runCli`.** It has no tool, no `--format`, no flags. If it fell through to `runCli`→`buildCatalogue`, it'd be an "unknown command" (exit 2). The entry switch catches it first.
- **Help footer** (`commands.ts:65`): currently `"Run with --mcp or no arguments to start the MCP server."` — reword to lead with `ticketgraph mcp` and note `--mcp`/no-args still work. `buildHelpText` is registry-derived for the command list; the footer is a hand-written string, so this is a one-line edit there.
- **Spawn-test harness already exists.** `tests/server.stdio.test.ts` builds once in `beforeAll`, spawns `node [SERVER]` via `spawnServer()`, and drives it with `tests/helpers/mcp-client.ts` (`waitForServerReady` waits for the `"ticketgraph starting"` stderr line; `sendRequest` does JSON-RPC over stdio). Add the `mcp` case **here**, not in a new file (the file's header note warns against replicating the `beforeAll` build; a new integration file would need vitest `globalSetup`).
- **SIGKILL-timer gotcha (load-bearing).** The `afterEach` (`server.stdio.test.ts:41-53`) captures the child in a local `const c = child` before arming the 1 s SIGKILL fallback — referencing the module-level `child` lets a slow-dying child's timer kill the *next* test's server (`code=null` flake). Any new spawn case must keep using this exact `afterEach`.
- **Version/release:** new CLI surface → minor bump **0.6.0**. Per `CLAUDE.md`: bump `package.json` + `.claude-plugin/plugin.json` (drift-guard test enforces parity), update the `tickets.ping` example in `docs/install.md`, tag `v0.6.0`, push, and **publish a GitHub release** (`gh release create`).

---

## Task 1: `ticketgraph mcp` command (entry switch + help + tests)

**Files:**
- Modify: `src/server.ts:110` (add the `mcp` trigger)
- Modify: `src/cli/commands.ts:65` (help footer)
- Modify: `tests/server.stdio.test.ts` (spawn case; generalise `spawnServer` to take args)
- Modify: `src/cli/commands.test.ts` (assert footer mentions `mcp`)

**Decisions:**
- `serverMode` gains `|| argv[0] === "mcp"` *because* starting the server is a mode selected at the entry point, alongside the existing `--mcp`. Keep it a literal third disjunct — no new abstraction for one token.
- Generalise `spawnServer(args: string[] = [])` → `spawn("node", [SERVER, ...args], …)` *because* the no-args path is already covered; the new case passes `["mcp"]`, and a regression case passes `["--mcp"]`. Default `[]` keeps the three existing tests unchanged.
- Help footer leads with `ticketgraph mcp` and notes `--mcp` / no-args still start the server, *because* `mcp` is now the preferred, discoverable form.

**Don't:**
- Don't route `mcp` through `runCli`/`dispatch`/`buildCatalogue` — it has no tool and would 404 as an unknown command. It stays in the `server.ts` entry switch.
- Don't change the existing stdio launch contract (`server.ts:105-108`) — no-args and `--mcp` must keep booting `main()` unchanged.
- Don't reference the module-level `child` inside the `afterEach` SIGKILL timer — capture it in a local first (`server.stdio.test.ts:46`), or a stale timer kills the next test's server.
- Don't add a second integration test file with its own `beforeAll` build — add the case to `server.stdio.test.ts` (header note at lines 8-12).

**Implement:** Add the `mcp` trigger to the entry switch; reword the help footer; generalise `spawnServer` to accept args and add a spawn case proving `ticketgraph mcp` boots + answers `initialize`/`tools/list`, plus a `--mcp` regression case; assert the help footer mentions `mcp`.

**Verify (TDD):**
- New spawn test: `child = spawnServer(["mcp"])` → `await waitForServerReady(child)` resolves (server logged `"ticketgraph starting"`) → `initialize` returns `serverInfo.name === "ticketgraph"`. Add a `spawnServer(["--mcp"])` case asserting the same (regression).
- `commands.test.ts`: `buildHelpText(registry)` output matches `/ticketgraph mcp/` and still mentions `--mcp`.
- Full `npm test` green; `node dist/server.js mcp` (manual) boots the server (logs `ticketgraph starting`, responds to stdin EOF by exiting).

---

## Task 2: CLI-first README restructure

**Files:**
- Modify: `README.md`

**Decisions:**
- Reorder so the CLI is the lede; demote MCP to a short optional section. Target order: (1) title + token-economy problem; (2) **Quick start (CLI)** — install/build then `ticketgraph list` / `next` / `search`; (3) token-efficiency USP; (4) common commands table (read/write); (5) Using with Claude — the one-line `CLAUDE.md` pointer; (6) **MCP server (optional)** — "ticketgraph also speaks MCP; start it with `ticketgraph mcp`. Opt-in — see docs/install.md."; (7) Migration / Development / Licence.
- Keep the existing `As of v0.4.0…` historical phrasing *because* it accurately records when dual-mode shipped — it's not a current-version claim. Update tool-count phrasing only if a number is now wrong.

**Don't:**
- Don't delete the Problem / token-economy framing — it's the project's USP and stays near the top.
- Don't rewrite history (`v0.4.0` notes) into present tense.

**Implement:** Restructure README per the order above; ensure the first runnable example is a CLI command, and the MCP appears only as a demoted optional section pointing at `ticketgraph mcp` + `docs/install.md`.

**Verify:** The first fenced command block under the lede is a `ticketgraph <command>` CLI example; the MCP section is below "Using with Claude" and references `ticketgraph mcp`. `grep -n "ticketgraph mcp" README.md` matches. Human read-through confirms CLI-first framing (no test applies — doc change).

---

## Task 3: docs/install.md — document the `mcp` launch command

**Files:**
- Modify: `docs/install.md` (the "Enabling the MCP server (optional)" section)

**Decisions:**
- Add `ticketgraph mcp` (and `node dist/server.js mcp`) as the launch command in the enable-MCP instructions, keeping the existing `--mcp`/no-args forms documented as equivalents *because* existing configs use them.

**Don't:**
- Don't remove the existing registration/launch forms — they remain valid.

**Implement:** Note `ticketgraph mcp` as the way to start the server in the MCP-enable section; keep the prior forms as equivalents.

**Verify:** `grep -n "ticketgraph mcp" docs/install.md` matches; the section still documents the existing forms. `node dist/server.js --help` shows the `mcp` guidance (footer from Task 1).

---

## Task 4: Version bump 0.6.0 + tag + GitHub release

**Files:**
- Modify: `package.json` (`0.5.0` → `0.6.0`)
- Modify: `.claude-plugin/plugin.json` (`0.5.0` → `0.6.0`)
- Modify: `docs/install.md` (`tickets.ping` example version → `0.6.0`)

**Decisions:**
- Minor bump (new CLI surface, backward-compatible) per `CLAUDE.md`. Keep `package.json`/`plugin.json` in sync (the drift-guard test in `tests/plugin-manifest.test.ts` enforces parity; `src/version.ts` reads `package.json` at runtime).

**Don't:**
- Don't touch the `As of v0.4.0…` historical strings (Task 2 already covers README prose).
- Don't tag/release until Tasks 1–3 are merged-to-working-tree and the full suite is green.

**Implement:** Bump both manifests + the ping example; after build+tests green, create annotated tag `v0.6.0`, push it, and `gh release create v0.6.0` with notes covering the `mcp` command + CLI-first README.

**Verify:** `node dist/server.js --version` → `0.6.0`; `tickets.ping` → version `0.6.0`; `npm test` green (drift guard passes). Post-release: `gh release list` shows `v0.6.0` as Latest. *(Tag/release are the human/runtime release step — execute after the code tasks pass review.)*

---

## Caveats & known risks

- **Back-compat is the whole point of Part A** — the regression spawn case (`--mcp`) and the unchanged no-args tests are the guard. If either breaks, the change is wrong.
- **Spawn-test flakiness** is a known hazard here; the SIGKILL-local-capture `afterEach` is mandatory, not optional.
- **Release step is easy to forget** (it's why GitHub sat at 0.3.0). Task 4 isn't done until `gh release list` shows v0.6.0.

---

## Review record

**Reviewed:** 2026-06-04
**Reviewer:** independent code-reviewer subagents — two-stage (spec + quality) per code task, plus a final whole-implementation pass (all APPROVE)
**Verification:** `npm run build` success; `npm run typecheck` clean; `npm test` 646 passed / 55 files. All three launch forms (`mcp`, `--mcp`, no-args) verified booting against the built `dist/server.js`.

### Triage Summary
| # | Finding | Type | Decision |
|---|---|---|---|
| 1 | All 4 tasks built as planned: `mcp` entry-switch trigger (additive), CLI-first README, install.md launch note, v0.6.0 bump | Completed as planned | — |
| 2 | `mcp` kept out of the registry/catalogue — entry-switch keyword only; never reaches `runCli` | Completed as planned | — |
| 3 | Release must target 0.6.0, not 0.5.0 (0.5.0 already tagged/released) | Confirmation of plan | Applied — bumped to 0.6.0 |
| 4 | `ticketgraph mcp --help` starts the server (mcp wins at the entry switch), doesn't print help | Edge case (accepted) | Documented in install.md as "launch mode, ignores trailing flags" |
| 5 | Stale doc comments (`server.ts:105-108`, `commands.ts` JSDoc) predated the `mcp` keyword | Deviation (docs) | Fixed during Task 1 review |

### Technical learnings (permanent record)
1. **Starting the server is a mode, not a tool.** The CLI catalogue is registry-derived; the `mcp` launch keyword belongs in the `server.ts` entry switch (`serverMode` disjunct), never `runCli`/`buildCatalogue` — otherwise it would 404 as an unknown command. Consequence: `mcp` ignores trailing flags (it's a mode), so `ticketgraph mcp --help` launches the server.
2. **Back-compat for MCP launch is load-bearing.** `--mcp` and no-args are what MCP clients launch over stdio; the change was purely additive and guarded by an explicit `--mcp` regression spawn test plus the unchanged no-args tests.
3. **Spawn tests share one `afterEach` that must capture the child in a local var** before arming the SIGKILL fallback (`server.stdio.test.ts:41-58`) — a module-level reference lets a slow-dying child kill the next test's server (`code=null` flake). New spawn cases go in the existing file to reuse this and the `beforeAll` build.

### Items Requiring Rework
None.

### Deferred/Skipped Items
None.
