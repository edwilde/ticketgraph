# T22 — CLI entrypoint + schema-driven dispatch — Implementation Plan

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task. **TDD throughout** (spec §16: three layers, fixtures version-controlled, every Acceptance bullet maps to a named test). Each code task below names its tests *first* (the red step) and the implementation second — and creates the module stub before the red test so the test **FAILs** (assertion) rather than **ERRORs** (module-not-found).

**Goal:** Make `ticketgraph` dual-mode — `ticketgraph <command> [--flags]` runs the same tools the MCP exposes, while no-args / `--mcp` keeps the stdio MCP server unchanged.
**Architecture:** A second thin front-end over the existing `makeToolRegistry`. The bin stays `dist/server.js`; its bottom becomes a mode dispatcher. CLI code lives in `src/cli/*` and is bundled into `dist/server.js` by tsup (no new entry). The registry is extracted to `src/registry.ts` so the CLI can build the tool map without importing `server.ts` (which runs the server on load).
**Tech Stack:** TypeScript (NodeNext, strict), tsup (single ESM bundle, `splitting:false`), vitest, better-sqlite3, `@modelcontextprotocol/sdk`.
**Project context cache:** not maintained for this run — full codebase context was gathered live in-session (server.ts, all relevant tools, tsup, version, the spawn-test harness, `vitest.config.ts`).

---

## Ticket-scoped context

Facts specific to T22 (generic invariants live in CLAUDE.md / the design spec). **All line numbers/claims below were verified against the code on 2026-05-31.**

- **Each tool is `Tool<TArgs,TResult>`** (`src/tools/types.ts`): `name`, `description`, `inputSchema` (JSON Schema; `properties` is typed `Record<string, unknown>`, `additionalProperties:false`, optional `required[]`), `parseArgs(raw)→TArgs` (throws `McpError(InvalidParams)`), `handle(args)→Promise<TResult>` (plain data). The MCP server wraps `handle`'s return in `{content:[{type:"text",text:JSON.stringify(result)}]}` (`server.ts:139-151`). The CLI reuses `parseArgs`+`handle` verbatim — **no second validation layer.**
- **`makeToolRegistry`** lives at `server.ts:56-88`, takes an **inline anonymous param** `{ db: Database.Database; dbPath: string; getClientRoots: GetClientRoots }` — **there is no named `RegistryDeps` type today** (`grep -n RegistryDeps src/server.ts` → 0 matches). It is pure (constructs tool objects + a Map; no I/O, no listeners). `dbPath` is destructured and forwarded to `makePingTool(deps)` only.
- **`main()` is invoked at `server.ts:178-181` as a 4-line `main().catch((err) => { logger.error("fatal", …); process.exit(1); })`** — NOT a bare `main()`. Importing `server.ts` therefore boots the server; the CLI must NOT import it.
- **`tsup.config.ts`**: `entry:["src/server.ts", …parsers]`, `splitting:false`, `external:["better-sqlite3","@modelcontextprotocol/sdk"]`, shebang banner, `onSuccess` copies `src/migrations`→`dist/migrations`. New `src/cli/*.ts` and `src/registry.ts` are inlined into `dist/server.js` **iff reachable from `src/server.ts`** — confirmed no new entry/config change needed.
- **Build for integration tests is already centralised** in `tests/helpers/global-setup.ts` (a vitest `globalSetup`, wired at `vitest.config.ts:5`). A new `tests/*.test.ts` integration file shares that one build automatically — **no `beforeAll` build, no migration needed.** (The stale comment in `server.stdio.test.ts:8` claiming "called once in beforeAll" is misleading but harmless — leave it.)
- **Project resolution** (`src/lib/projects.ts:requireProject`): resolves from `opts.project` (explicit) else `[...roots, process.cwd()]` longest-prefix match; **throws `McpError(InvalidParams)` if no registered project matches.** With `NO_ROOTS` (`src/lib/roots.ts:5` = `async () => []`) it falls straight to `process.cwd()` — correct for a CLI. **Consequence for tests:** a temp DB has no project at the test runner's cwd, so every test invocation MUST either register a project whose `root_path` is the test's cwd/temp dir, OR pass `--project <id>` explicitly. Otherwise the tool throws and the CLI exits non-zero for the wrong reason.
- **Command-name rule:** CLI command = tool name minus the `tickets.` prefix, **underscores preserved** (`tickets.add_many`→`add_many`, `tickets.register_project`→`register_project`). One mechanical rule, no `_`→`-` prettification (optimise for Claude's accuracy — Ed's standing preference).
- **Only `add_many` requires structured input** (arrays of objects). `import_json` is all-scalar (`project`,`file`,`dry_run`,`force`) reading a file path; `link` is scalar. So flat flags cover every command except `add_many`, which uses the `--json` escape hatch.
- **Positional binding — verified `required` arrays:** single-id-subject commands safe for a lone positional are `get` (no `required`; `id` OR `ids` handled in `parseArgs`), `related`/`blockers_of`/`children_of` (`required:["id"]`). The commands `set_parent` (`["id","parent_id"]`), `add_tag`/`remove_tag` (`["id","tag"]`), `append_to_description` (`["id","text"]`) have a **second required field** a lone positional can't supply → they are **excluded** from the positional map and use explicit flags.
- **`busy_timeout` is unset** in `openDb` (`src/db.ts` sets WAL/foreign_keys/synchronous only). With `better-sqlite3`'s 0 ms default, a CLI write handle contending with a live MCP server (or a second CLI) on `~/.claude/tickets.db` throws `SQLITE_BUSY` immediately — the *primary* dual-mode use case. T22 sets a `busy_timeout` (Task 2).
- **`--help` gate** at `server.ts:5-16` prints the MCP one-liner. T22 removes it; `--help`/`--version` become CLI concerns (basic here, registry-generated in T25).

---

## Task 1: Extract `makeToolRegistry` → `src/registry.ts` + add `busy_timeout`

**Files:**
- Create: `src/registry.ts`
- Modify: `src/server.ts` (remove `makeToolRegistry` at `56-88` and the 23 `make*Tool` imports it owns; add `import { makeToolRegistry, type RegistryDeps } from "./registry.js"`; the call at `:127` is unchanged)
- Modify: `src/db.ts` (add one PRAGMA in `openDb`)

**Decisions:**
- **Define a new exported `RegistryDeps` interface in `registry.ts`** from the current inline param type (`{ db: Database.Database; dbPath: string; getClientRoots: GetClientRoots }`) — it does not exist as a named type today, so this is authored fresh, not cut-and-pasted. `makeToolRegistry` and all `make*Tool` imports move with it.
- `registry.ts` imports **no** SDK `Server`/transport — only the tool factories (which import `McpError` from `sdk/types.js`; lightweight, fine).
- Pure refactor of the registry — **zero behaviour change.** Within this task, `server.ts` re-imports `makeToolRegistry` from `./registry.js` so the build stays green at task end (the cut and the re-import land together — there is no green state between them otherwise).
- **`db.pragma("busy_timeout = 5000")` in `openDb`**, applied right after the WAL/foreign_keys/synchronous block, *because* dual-mode means concurrent writers on one WAL DB; 5 s lets a contended write wait for the other handle instead of throwing `SQLITE_BUSY` at 0 ms. Benefits the server too. Standard SQLite concurrency setting, not a workaround.

**Don't:**
- Don't change tool order or the `as unknown as AnyTool` casts — keep the move byte-faithful (the stdio tests assert the wire surface).
- Don't leave `server.ts` without the re-import — the build must be green when this task closes.

**Implement:** Move `makeToolRegistry` + its tool imports into `registry.ts`, exporting `RegistryDeps`; re-import in `server.ts`. Add the `busy_timeout` PRAGMA to `openDb`.

**Verify (test-first):**
- Red: add a `src/db.test.ts` (or extend existing) case asserting `openDb` yields `db.pragma("busy_timeout",{simple:true}) === 5000` — fails before the PRAGMA is added.
- Green + regression: `npm run build` green; `npm test` green — the existing `tests/server.stdio.test.ts` (unchanged) proves `tools/list` still includes `tickets.ping` and `tickets.ping` still returns `{ok,version}`, i.e. the registry is end-to-end identical.

---

## Task 2: Command catalogue + `runCli` skeleton (DB open, registry, resolve)

**Files:**
- Create: `src/cli/commands.ts` (`cliNameFor`, `toolNameFor`, `buildCatalogue(registry)`)
- Create: `src/cli/index.ts` (`runCli(argv: string[]): Promise<number>`)
- Create: `src/cli/commands.test.ts`, `src/cli/index.test.ts`

**Decisions:**
- `cliNameFor`/`toolNameFor` are **pure string functions** (no DB) — `cliNameFor("tickets.add_many")==="add_many"` and round-trip. `buildCatalogue` maps a built registry to `Map<cliName, AnyTool>`.
- `runCli` returns an **exit code** (never calls `process.exit`) so it is unit-testable; the entry maps the code to `process.exit` (Task 6). Code contract (refined in T23): `0` success, `2` usage/unknown-command/unknown-flag, `1` runtime error.
- `runCli` pipeline *for this task*: parse first positional as command → `openDb()` (write) → `makeToolRegistry({db,dbPath,getClientRoots:NO_ROOTS})` → `buildCatalogue` → resolve command. **Unknown command → close DB, return `2`** with a stderr usage line. **Known command → delegate to a `dispatch()` stub** (created in Task 5) — for now the stub may return `1`/throw "not implemented"; this task only proves resolution + exit `2`.
- **DB write mode always** (`openDb()` default) *because* the MCP server uses one write handle and migrations must apply on first run; `openDb({readonly:true})` **throws** on pending migrations (`db.ts:54-67`). Read-only-for-reads is a non-goal.

**Don't:**
- Don't open `openDb({readonly:true})` for read commands — it throws on a fresh/stale DB. Write mode always.
- Don't call `process.exit()` inside `runCli` — return the code; close the DB in `finally`.

**Implement:** the two modules above, with `dispatch` imported from `./dispatch.js` as a stub so imports resolve (Task 5 implements it).

**Verify (test-first):**
- Red (`commands.test.ts`): create `commands.ts` exporting stubs that `throw "not implemented"`, write tests for `cliNameFor`/`toolNameFor`/`buildCatalogue` → they FAIL (assertion). Then implement → green.
- Red (`index.test.ts`): `runCli(["bogus"])` resolves to `2` and writes a usage message to a captured stderr. **Seed the temp DB with a registered project at the test cwd (or assert the unknown-command path returns `2` before any project resolution happens).** Implement → green.

---

## Task 3: Schema-driven flag parser (`src/cli/flags.ts`) — the contract

**Files:**
- Create: `src/cli/flags.ts` (`parseFlags(schema, tokens) → { values: Record<string, unknown>; positionals: string[] }`)
- Create: `src/cli/flags.test.ts`

This task **defines the parsing contract.** The behaviour table is the spec; tests assert each row.

| Input tokens | property type in `inputSchema` | Produces |
|---|---|---|
| `--limit 5` / `--limit=5` | `number` | `{ limit: 5 }` (coerced via `Number`; NaN left for `parseArgs` to reject) |
| `--project foo` | `string` | `{ project: "foo" }` |
| `--include_description` | `boolean` | `{ include_description: true }` (presence = true; consumes no value) |
| `--status open` | `oneOf[string,array]` | `{ status: "open" }` (seen once → scalar) |
| `--status open --status blocked` | `oneOf[string,array]` | `{ status: ["open","blocked"] }` (seen >1 → array) |
| `--tag a` (property type `array`) | `array` | `{ tag: ["a"] }` (array-typed prop → always array) |
| `--bogus x` | not in schema | **structural error** → caller maps to exit `2` |
| `T22` (bare positional) | — | collected into `positionals[]` (bound in Task 4) |

**Decisions:**
- `inputSchema.properties` is `Record<string, unknown>`. Define a **local `interface PropSchema { type?: string; oneOf?: Array<{ type?: string }> }`** and cast each property to it **once** at lookup; the rest of `parseFlags` operates on typed values (avoids `any`-ridden code / repeated strict-mode errors).
- Coercion is type-driven: `number`→`Number`; `boolean`→presence-true (consumes no value); `array`→accumulate; `oneOf` containing an `array` member→"repeated⇒array, single⇒scalar"; else→string passthrough.
- The parser **does not validate values** (enums/ranges/required stay in the tool's `parseArgs` — single source of truth). Its only errors are *structural*: unknown flag, value-flag missing its value, (positional handling is Task 4).
- Support both `--key value` and `--key=value`. A value beginning with `--` is only accepted via the `=` form (document this limitation; surfaced in `--help` at T25).

**Don't:**
- Don't re-validate enums/ranges — duplicates `parseArgs` and they will drift.

**Implement:** left-to-right token walk classifying against `PropSchema`; accumulate per the table; collect positionals separately.

**Verify (test-first):** create `flags.ts` with `parseFlags` stub throwing "not implemented" so the red tests FAIL not ERROR; write one test per table row against real schemas (`tickets.list` for oneOf+number+boolean; `tickets.link` for required scalars; an array-typed property; unknown-flag → structural error). Implement → green.

---

## Task 4: Positional binding + `--json` escape hatch

**Files:**
- Create: `src/cli/input.ts` (`resolveRawArgs(cliName, tokens) → Record<string, unknown>`)
- Modify: `src/cli/flags.ts` (positional → param binding helper)
- Create: `src/cli/input.test.ts`

**Decisions:**
- **Primary positional map (verified, narrowed):** `{ get:"id", related:"id", blockers_of:"id", children_of:"id" }` only — these are the commands whose sole/primary required input is one id. A lone positional binds to the mapped param: `ticketgraph get T22` ⇒ `{ id:"T22" }`. >1 positional, or a positional for an unmapped command ⇒ structural error (exit `2`). **`set_parent`/`add_tag`/`remove_tag`/`append_to_description` are deliberately NOT in the map** — each has a second required field a positional can't fill, so they take explicit flags (`ticketgraph add_tag --id T1 --tag urgent`).
- **`--json <string>`** is parsed and used **verbatim** as the raw args object handed to `parseArgs` (bypasses flag parsing). **`--json -` reads the JSON from stdin.** This is the universal structured-input hatch and the **only** way to drive `add_many`.
- **No implicit/bare-pipe stdin auto-read.** *because* a TTY-detection auto-read (`!process.stdin.isTTY`) silently fires in vitest's non-TTY environment and hangs unit tests, and is surprising. Stdin is opt-in via the explicit `--json -` marker. (Updates the T22 ticket's bare-`cat | …` shorthand to `cat batch.json | ticketgraph add_many --json -`.)
- `--json` is **exclusive** of flags/positionals: its parsed object is the complete raw args. `--json` together with any `--flag` or positional ⇒ structural error (exit `2`).
- `--json` content is the **full args object** (e.g. `{"tickets":[…]}` for `add_many`), not a bare array — mechanical and predictable.

**Don't:**
- Don't auto-read stdin without `--json -`. No `isTTY` heuristics.
- Don't merge `--json` with flags — exclusive, or it's a structural error.
- Don't let `add_many` fall through to flag parsing — if invoked with flags, error with an explicit "`add_many` requires `--json '{\"tickets\":[…]}'` or `--json -`" message (not a confusing `parseArgs` "tickets must be a non-empty array").

**Implement:** `resolveRawArgs`: if `--json` present → read string or stdin (`-`) → `JSON.parse` → that object; else → `parseFlags` + bind positionals via the map. Hand the result to the caller (Task 5 passes it to `parseArgs`).

**Verify (test-first):** create `input.ts` with `resolveRawArgs` stub throwing "not implemented" so red tests FAIL; **unit-test `resolveRawArgs` directly** (no dispatch): `--json '{"tickets":[{"title":"x"}]}'` returns that object; `get T22` ⇒ `{id:"T22"}`; `--json '…' --project x` ⇒ structural error; `add_many` with flags ⇒ the explicit-hatch error; `--json -` reads a provided readable stream (inject the stream, don't touch real `process.stdin`). **Defer the end-to-end "creates a ticket" assertion to Task 8.**

---

## Task 5: Dispatch — `parseArgs → handle → print`

**Files:**
- Create: `src/cli/dispatch.ts` (`dispatch(tool, rawArgs) → Promise<{ stdout: string; code: number }>` or similar) — replaces the Task 2 stub
- Modify: `src/cli/index.ts` (wire resolve→dispatch)
- Create/extend: `src/cli/dispatch.test.ts`

**Decisions:**
- Pipeline: resolved command → `resolveRawArgs` → `tool.parseArgs(raw)` → `await tool.handle(args)` → emit `JSON.stringify(result)` to **stdout** → return `0`. (Compact/table formatting is **T24**; T22 emits single-line JSON.)
- Error handling (basic; full matrix is T23): catch → write `err.message` (no stack) to **stderr** → return `1`. `McpError` lands here too (T23 maps it to `2`). `db.close()` in a `finally`.
- stdout = results only; stderr = diagnostics only (clean pipes).

**Don't:**
- Don't leak stack traces — message only.
- Don't skip `db.close()` in `finally` — a leaked WAL handle can wedge the next invocation.

**Implement:** the linear pipeline with try/catch/finally; `index.ts` calls `dispatch`.

**Verify (test-first):** red test in `dispatch.test.ts` against a **seeded temp DB with a project registered at a known path**, calling the dispatch path with `{project:"<id>", …}` (explicit `--project` so cwd resolution is bypassed): `list` prints JSON matching the equivalent `tool.handle` call; a bad arg prints one stderr line and returns `1`, nothing on stdout. Implement → green.

---

## Task 6: Dual-mode entry in `server.ts`

> **Prerequisite: Tasks 2–5 complete** (this task statically imports `runCli` from `./cli/index.js`).

**Files:**
- Modify: `src/server.ts` — add `import { runCli } from "./cli/index.js"`; remove the `--help` gate (`5-16`); replace the `main().catch(...)` block (`178-181`) with the mode dispatcher.

**Decisions:**
- **Mode rule:** `const argv = process.argv.slice(2); const serverMode = argv.length === 0 || argv[0] === "--mcp";`
  - `serverMode` → strip a leading `--mcp`, then run `main().catch(...)` **with the existing 4-line fatal handler preserved**.
  - else → `runCli(argv).then(code => process.exit(code)).catch(err => { logger.error("cli fatal", {err:String(err)}); process.exit(1); })`.
- **No-args MUST stay server mode** *because* MCP clients launch `node dist/server.js` with no args over stdio — changing it breaks every existing connection. Help is `ticketgraph --help` (routed to CLI). Document prominently.
- Remove the early `--help` one-liner; `--help`/`--version` are CLI concerns. Basic handling in T22 (`--help` → terse stub + command list; `--version` → `getPackageVersion()`); T25 makes `--help` registry-generated + per-command.
- **Keep static SDK imports / single bundle** *because* tsup has `splitting:false`. The SDK-load cost in CLI mode is negligible (no transport opened, process exits after one command) and is NOT the token win — that's T26 (MCP opt-in). (If cold-start ever matters: SDK is `external`, so dynamic `import()` works under `splitting:false` — deferred YAGNI.)

**Don't:**
- **DELETE-not-supplement:** the `main().catch(...)` block at `178-181` is *replaced* by the dispatcher, never added alongside it. After the edit, the identifier `main` appears in `server.ts` exactly twice — the `async function main()` declaration and the one call inside the `serverMode` branch. If both `main()` and `runCli()` can run in one process you have created a dual-boot race (server reads stdin while CLI runs) — verify by inspection.
- Don't drop the fatal `.catch` on either branch — preserve the existing error→`process.exit(1)` behaviour for server mode and add the equivalent for CLI.
- Don't install the T18 shutdown handlers (`stdin.on("end"/"close")`, SIGHUP/SIGTERM/SIGINT, the unref'd failsafe) on the CLI path — they live inside `main()` and must only arm in server mode. A CLI process exits naturally.

**Implement:** add the import; delete the `--help` block; branch at module bottom per the mode rule.

**Verify:** integration (Task 8) — `node dist/server.js` (no args) still completes `initialize`→`tools/call ping` (existing stdio test green); `node dist/server.js list --help` exits `0` without opening a transport; `node dist/server.js --version` prints the semver. Also `npm test` green (no lingering handles — a CLI invocation exits on its own).

---

## Task 7: Spec amendment (reverse the "No CLI" non-goal)

**Files:**
- Modify: `docs/specs/2026-05-28-ticketgraph-design.md` — §5 (YAGNI "No CLI"), the Non-goals statement, and add a dated "Reversed decisions" note.

**Decisions:**
- Amend honestly (mirror the existing T21 reversal annotations): keep the original "No CLI" text struck/annotated, not deleted, with the one-line rationale (token efficiency — CLI ~0 context until used vs the MCP always-on schema tax; MCP becomes opt-in in T26) and the 2026-05-31 date.

**Don't:** Don't silently rewrite history — dated annotations preserving the original decision are the spec's convention.

**Verify:** `git diff` touches `docs/specs/` in the same PR (acceptance criterion).

---

## Task 8: End-to-end spawn integration test

> Unit tests live in their owning tasks (2–5). **This task is the spawn-only integration file** — it is the one thing that genuinely cannot exist until the build produces a dual-mode `dist/server.js` (after Task 6).

**Files:**
- Create: `tests/cli.spawn.test.ts`

**Decisions:**
- Shares the existing `tests/helpers/global-setup.ts` build — **no `beforeAll` build, no globalSetup change.** Confirmed `vitest.config.ts:5` wires it.
- Isolate with `TICKETGRAPH_DB_PATH` in a `mkdtempSync` temp dir (spec §16: never touch the live `~/.claude/tickets.db`).
- **CLI spawn tests do NOT use `waitForServerReady`/`sendRequest`** (those wait for the MCP `"ticketgraph starting"` stderr line a CLI never logs → immediate confusing `"closed (code=0) before ready"`). Instead: spawn `node dist/server.js <args>`, collect `stdout`/`stderr` from `data` events, `await` the `close` event, then assert `exitCode` + buffers. Per-test `{ timeout: 5000 }` (CLI is fast; a 5 s cap catches hangs quickly). Only the **no-args MCP regression test** reuses the MCP helpers.
- **Project seeding:** before asserting any tool command, spawn `register_project --id <id> --path <tmpdir>` (or pass `--project <id>` on each command) so `requireProject` never falls back to the runner's cwd. Assert on stdout content (e.g. the created ticket id), not exit code alone, so failures are diagnosable.
- **Spawn-cleanup discipline (repo gotcha):** CLI children exit on their own — prefer awaiting `close` over killing. If a child is held at module scope, copy it into a local in `afterEach` before any SIGKILL fallback timer, so a slow child's timer can't kill the next test's process (the documented `code=null` flake).

**Implement:** one spawn test per T22 Acceptance bullet — mode detection (no-args boots MCP; `list` runs CLI; unknown command exits `2`), `add_many --json '{…}'` creates a ticket, `add_many --json -` via a piped stdin creates a ticket, `get <id>` positional, unknown flag exits `2`, `--version`/`list --help` exit `0`, no stack on stdout.

**Verify:** `npm test` green including the new file; suite stays deterministic (repo bar: repeatable green — run the suite 2–3× to confirm no flake).

---

## Caveats & known risks

- **ESM hoisting:** static SDK imports load regardless of the mode branch; accepted (negligible) and the misleading "fast --help" gate is removed. Honest, not a regression.
- **`add_many` via flags is intentionally unsupported** — `--json`/`--json -` only, with an explicit error if flags are used (Task 4 Don't).
- **`--json -` stdin** is the single stdin path; inject a readable stream in unit tests rather than touching real `process.stdin`.
- **Concurrency:** `busy_timeout=5000` (Task 1) is the mitigation for CLI↔MCP / CLI↔CLI write contention on the WAL DB. If a write still exceeds 5 s under contention, the user sees `SQLITE_BUSY` — T23 owns turning that into a friendly message + exit code.
- **Dual-boot guard** (Task 6 Don't) is the single highest-severity failure mode — verify by inspection that no path runs both `main()` and `runCli()`.

---

## Validation review

Stress-tested by the `devils-advocate` skill (2026-05-31) — three parallel fresh-context challengers (pre-mortem, hidden-assumptions, sequencing). Findings applied to this plan:

**Blocking (applied):**
- `RegistryDeps` is authored fresh (no named type exists today) — Task 1 corrected.
- Task 6 must **replace, not supplement** `main().catch(...)` (else dual-boot race), preserve the fatal `.catch` per branch, add `import { runCli }`, and is gated on Tasks 2–5 — Task 6 corrected; dual-boot promoted to the top caveat.
- TDD red steps would ERROR (module-not-found) not FAIL — every code task now creates a throwing stub *before* its red test; unit tests moved into their owning tasks; Task 8 reframed as spawn-only.
- CLI spawn tests must not use `waitForServerReady` — Task 8 specifies the `close`-event pattern + 5 s timeout.
- `requireProject` cwd trap — Tasks 2/5/8 now register a project at the test path or pass `--project`.

**Important (applied):**
- Positional map narrowed to the four verified single-id commands; the four two-required commands excluded (Task 4).
- Implicit bare-pipe stdin dropped in favour of explicit `--json -` (removes the vitest TTY hang); ticket shorthand updated.
- `busy_timeout=5000` added to `openDb` (Task 1) for WAL write contention.
- `parseFlags` introspects `unknown` property shapes via a single-cast local `PropSchema` interface (Task 3).
- Task 2/5 boundary clarified (catalogue+skeleton vs full dispatch).
- Build coupling resolved: `global-setup.ts` already exists — the proposed "migrate beforeAll" sub-task was unnecessary (the challenger trusted a stale comment; verified false).

**Notes (acknowledged, no change):** `dbPath` is forwarded to `ping` only (available from `openDb`); WAL-on-readonly is moot (write-mode-always).

---

## Review record

**Reviewed:** 2026-05-31
**Reviewer:** Claude (Opus subagents, fresh context — per-task spec+quality gates plus one final whole-implementation pass)
**Branch:** feat/t21-export-markdown (T22 work uncommitted at review time)
**Verification:** `npm run build` ✓, `npm run typecheck` ✓, `npm test` **563 passed / 54 files**, run twice — deterministic (counts matched). LSP clean on all new/changed source.

### Triage summary
All findings were APPROVED-as-built or are inconsequential Notes. **No items denied; no rework outstanding.** (User triage skipped: the run was under an autonomous `/goal`, and no finding required a decision — everything is correct-by-design or a no-fix Note.)

| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | `busy_timeout` is already 5000ms by better-sqlite3 default; the test locks the value-contract, not deliberate-set | Deviation | Approved — explicit PRAGMA kept for self-documentation + driver-version independence; test comment added |
| 2 | `RegistryDeps` exported but `server.ts` imports only `makeToolRegistry` (importing the unused type would fail strict TS) | Deviation | Approved — type is public API for the registry module; used by the CLI deps literals |
| 3 | `--json=<value>` / `--json=-` (equals form) added after review found the bare-token detector rejected it | Deviation (added) | Approved — `add_many`'s only interface is `--json`; the `=` form must work like every other flag |
| 4 | `metadataRegistry()` hardened from `null as unknown as Database` → `new Database(":memory:")` in a `try/finally` | Deviation | Approved — removes the type-lie and the silent "no construction-time db deref" invariant `--help` relied on |
| 5 | `resolveRawArgs(tool, cliName, tokens)` takes the tool, not just `cliName` (plan showed `(cliName, tokens)`) | Deviation | Approved — needs `tool.inputSchema` for flag parsing; dispatch already holds the tool |
| 6 | `db.close()` lives in `runCli`'s `finally`, not `dispatch`'s | Deviation | Approved — single owner of the DB lifecycle; avoids double-close; keeps `dispatch` I/O-pure and unit-testable |
| 7 | `add_many` passes `project` INSIDE the JSON (`{"project":…,"tickets":[…]}`), not as a `--project` flag | Deviation | Approved — `--json` is exclusive of flags by design (the parsed object is the complete raw args) |
| 8 | CLI success path emits a benign `INFO migrations: applied…` line to stderr | Deviation | Approved for T22 — suppressing CLI info-chatter behind `--verbose`/`TICKETGRAPH_DEBUG` is **T23** scope; tests assert "no ERROR / no stack" not empty-stderr |
| 9 | `RegistryDeps` wider-than-used export; `toolNameFor` exercised only by its round-trip invariant; `--help` short-circuits anywhere in argv (so `bogus --help`→0) | Note ×3 | Skipped — no fix; intentional / future-use (T24/T25) |

### Technical context & learnings (for future sessions)
- **One registry, two front-ends.** `makeToolRegistry` was lifted from `server.ts` into `src/registry.ts` so the CLI builds the identical tool map without importing `server.ts` (which boots the stdio server on load). `server.ts` is now a thin dual-mode dispatcher; the CLI lives in `src/cli/*` and is bundled into `dist/server.js` transitively (tsup `splitting:false`, no new entry).
- **Mode rule:** `argv.length===0 || argv[0]==="--mcp"` → MCP server (unchanged, incl. all T18 shutdown handlers, which arm ONLY in server mode); anything else → `runCli(argv)` which returns an exit code (never calls `process.exit`) and exits naturally. `main` appears exactly twice in `server.ts` — declaration + the one server-mode call — so a dual-boot race is structurally impossible.
- **`--json` is the structured-input hatch and is EXCLUSIVE.** Only `add_many` needs it (arrays of objects); `import_json` (scalar + file path) and `link` (scalar) work via plain flags. Because `--json` must be the sole input, any `project`/filters for an `add_many` batch go *inside* the JSON object. Forms: `--json '<obj>'`, `--json=<obj>`, `--json -` (stdin).
- **Positional binding** is limited to the four single-`id` commands (`get`, `related`, `blockers_of`, `children_of`); commands with a second required field (`set_parent`, `add_tag`, `remove_tag`, `append_to_description`) take explicit flags.
- **Flag validation has one home.** `parseFlags` does structural coercion only (number/boolean/array/oneOf, driven by a single-cast local `PropSchema`); all enum/range/required validation stays in each tool's `parseArgs` — no duplicate, drift-prone layer.
- **Exit codes:** 0 success; 2 usage (unknown command/flag, bad `--json`, illegal positional); 1 runtime (incl. `McpError` for now — T23 remaps `McpError`→2 and adds the friendly SQLITE_BUSY message + cwd/git-root resolution + info-log suppression).
- **`busy_timeout=5000`** is now explicit in `openDb` (it was unset; better-sqlite3's default happens to also be 5000 — the explicit PRAGMA documents intent and survives driver-default changes), guarding the dual-mode concurrent-writer case on the shared WAL DB.

### Items requiring rework
None.

### Deferred/skipped items
- CLI info-log suppression (the stderr `INFO migrations` line) → **T23**.
- Richer/per-command `--help` and the `--key=value`-with-leading-`--` documentation → **T25**.
- `--help` precedence note (`--mcp --help` boots the server and ignores `--help`) → document in **T26** docs.
