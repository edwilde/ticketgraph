# T2 — MCP stdio server skeleton

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Replace the T1 stub with a real MCP stdio server that registers a single `tickets.ping` tool, logs to stderr only, shuts down cleanly on SIGTERM/SIGINT, and has a vitest stdio smoke test.
**Architecture:** Single ESM entrypoint. Uses `@modelcontextprotocol/sdk@^1.29.0`'s high-level Server + StdioServerTransport. Tool handlers live in `src/tools/` (one file per tool, even with only one tool today — sets the pattern for T5). `src/logger.ts` is a tiny stderr-only logger used everywhere.
**Tech Stack:** TypeScript ESM, @modelcontextprotocol/sdk, Node 20 child_process for the vitest smoke harness.

---

## Ticket-scoped context

- **stdout is sacred** — MCP framing uses stdout. Every log line must go to stderr. A stray `console.log` corrupts the protocol stream silently. The logger module is the chokepoint that enforces this.
- The tool name registered in T2 is `tickets.ping`. The spec (§6 Admin tools) says it returns `{ ok: true, version, db_path, schema_version }`. T2 fulfils a *subset*: `{ ok: true, version }`. `db_path` and `schema_version` are deferred to T3 — note this in the tool's description so the deferral is visible.
- MCP tool names in the SDK are typically dot-namespaced (`tickets.ping`). Confirm against the installed SDK if dotted names need escaping; the SDK accepts arbitrary strings.
- The `tickets.ping` response is JSON returned through the MCP `tools/call` envelope. The MCP SDK wraps this for us — handler returns `{ content: [{ type: "text", text: JSON.stringify({ ok, version }) }] }`.
- Version source: same `readFileSync` of `package.json` used in T1's stub.
- `src/server.ts` still needs to satisfy `--help` from T1 (don't break that gate).
- The smoke test must spawn the *built* server (`dist/server.js`), not run TypeScript through a transpiler. This validates the actual shipped artifact.
- Test isolation: the smoke test must NOT depend on `~/.claude/tickets.db`. T2 doesn't open a DB, so this is trivially satisfied — re-check when T3 lands.

---

## Task 1: Add stderr logger

**Files:**
- Create: `src/logger.ts`

**Decisions:**
- Plain function module: `export function info(msg: string, meta?: Record<string, unknown>): void` and `error(msg: string, meta?: Record<string, unknown>): void`. *Because* a 50-line dependency-free logger is enough; no need for pino/winston for stderr lines.
- Output format: ISO timestamp + level + msg + JSON-stringified meta. Single line each. *Because* one-line-per-event is grep-friendly and matches MCP server log conventions.
- All output via `process.stderr.write(line + "\n")`. NEVER `console.log` anywhere in the codebase. The logger is the single allowed point of stderr writing.

**Don't:**
- Don't introduce a `debug` or `warn` level yet — adds API surface for no current use.
- Don't read an env var like `LOG_LEVEL` — premature; add when needed.

**Implement:** Write `src/logger.ts` exporting `info` and `error`. Each builds the line and writes to stderr.

**Verify:** Unit test `tests/logger.test.ts` (or `src/logger.test.ts`): asserts that calling `info("hi", { x: 1 })` writes a line matching `/INFO hi {"x":1}/` to `process.stderr` (use vitest's `spyOn(process.stderr, 'write')`).

---

## Task 2: tools/ping handler

**Files:**
- Create: `src/tools/ping.ts`
- Create: `src/tools/ping.test.ts`

**Decisions:**
- Tool name `tickets.ping`. Description: "Liveness check. Returns { ok: true, version }. db_path / schema_version arrive once the DB layer lands (T3)."
- Input schema: empty object (`{ type: "object", properties: {}, additionalProperties: false }`).
- Handler signature: `async function handle(_args: unknown): Promise<{ ok: true; version: string }>`. *Because* the handler returns pure data; the server module wraps it into the MCP `content` envelope.
- Version sourced from `getPackageVersion()` (Task 4). The handler doesn't read package.json itself — keeps it testable.

**Don't:**
- Don't return `{ ok: false }` ever; failure should throw. MCP framing will turn a thrown error into a JSON-RPC error response.

**Implement:** Export `pingTool` object with `{ name, description, inputSchema, handle }`. Handler returns `{ ok: true, version: getPackageVersion() }`.

**Verify:** Unit test asserts `handle({})` returns `{ ok: true, version: <pkg version> }`. Test mocks `getPackageVersion` to a fixed string so the assertion is exact.

---

## Task 3: package.json version helper

**Files:**
- Create: `src/version.ts`

**Decisions:**
- Single exported function `getPackageVersion(): string`. Reads `package.json` once and caches the value in a module-level constant. *Because* repeated readFileSync at every ping is wasteful; the version is immutable for a given server process.
- Validation: parse the JSON, then `if (typeof pkg.version !== "string") throw new Error("package.json missing version")`. *Because* the T1 review flagged the unguarded cast as a LOW item to fix once the file got real logic — this is that moment.
- Resolves `package.json` via `fileURLToPath(import.meta.url)` + `path.resolve(__dirname, "../package.json")`. Built `dist/version.js` resolves `../package.json` correctly because tsup outputs to `dist/` next to package.json.

**Don't:**
- Don't import package.json — JSON import attributes are still rocky across Node 20 minors.

**Implement:** Read + parse + validate + cache + return.

**Verify:** Unit test: calling `getPackageVersion()` twice returns the same string equal to the version in `package.json` (read independently in the test).

---

## Task 4: server.ts — MCP stdio wiring

**Files:**
- Modify: `src/server.ts` (replace the T1 stub)

**Decisions:**
- Keep the `--help` short-circuit at the top — runs BEFORE any SDK import work — so the gate from T1 still passes.
- Use `Server` + `StdioServerTransport` from `@modelcontextprotocol/sdk/server/index.js` and `@modelcontextprotocol/sdk/server/stdio.js`.
- Server identity: `{ name: "ticketgraph", version: getPackageVersion() }` with capabilities `{ tools: {} }`.
- Register `tickets.ping` via `server.setRequestHandler(ListToolsRequestSchema, …)` returning the tool list, and `server.setRequestHandler(CallToolRequestSchema, …)` dispatching by name to `pingTool.handle`. If the requested tool name doesn't match, throw an MCP `McpError(ErrorCode.MethodNotFound, ...)` so the SDK surfaces a proper JSON-RPC error.
- On startup: `logger.info("ticketgraph starting", { version, pid })`. On every `tools/call`: `logger.info("tool called", { name })`.
- Graceful shutdown: `process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown)` where `shutdown()` is `async () => { await server.close(); process.exit(0); }`. Idempotent — guard with a `shuttingDown` flag so double-signal doesn't double-exit.
- Top-level `main()` is an `async function` invoked via `main().catch((err) => { logger.error("fatal", { err: String(err) }); process.exit(1); })`. *Because* an unhandled top-level rejection should terminate the process loudly, not silently.

**Don't:**
- Don't import `console.log` ANYWHERE. The MCP framing on stdout breaks if anything else writes to stdout.
- Don't bundle SDK or better-sqlite3 (tsup `external` already covers this; reconfirm if changing imports).
- Don't add additional tools yet — the only tool surface today is `tickets.ping`. T5 adds the read tools.

**Implement:** Rewrite `src/server.ts` to: parse `--help`; instantiate the SDK Server with version + tool capability; wire ListTools and CallTool handlers using the tool registry pattern (Map<string, Tool>); connect StdioServerTransport; install SIGINT/SIGTERM handlers; run `main()`.

**Verify:** The integration test from Task 5 is the canonical proof. `npm run build && node dist/server.js --help` still prints the usage stub.

---

## Task 5: Stdio smoke integration test

**Files:**
- Create: `tests/server.stdio.test.ts`
- Create: `tests/helpers/mcp-client.ts`

**Decisions:**
- The smoke test spawns the built server with `node dist/server.js`. *Because* the acceptance criterion is "`claude mcp add` + `tickets.ping()` works" — the built artifact is what gets shipped.
- Test does its own MCP handshake by writing JSON-RPC lines to the child's stdin and reading from stdout. We do NOT pull in the SDK's *client* library here; the smoke test should fail loudly if the wire format changes. Keep it minimal: send `initialize`, then `tools/list`, then `tools/call` for `tickets.ping`. Assert response shapes against the JSON-RPC 2.0 envelope.
- The helper `mcp-client.ts` exports `sendRequest(child, method, params)` returning the parsed response. Uses newline-delimited JSON; line buffer cleared per response. Times out after 5s per request — fail fast.
- Each integration test gets a fresh child process. `afterEach` kills the child (`SIGTERM`, then `SIGKILL` after 1s if still alive).
- Test must run *before* T3 so it doesn't depend on a DB. Skip any env-var setup beyond `TICKETGRAPH_DB_PATH` left unset — but the server in T2 doesn't open a DB so this is moot today; revisit in T3.
- The build must run before the integration test. Either (a) `vitest` invokes `npm run build` as a globalSetup, or (b) the test itself calls `execSync("npm run build")` once in `beforeAll`. Pick (b) — keeps build coupling visible in the test file. Annotate with a comment so future-me doesn't replicate it elsewhere.

**Don't:**
- Don't shell out to `claude mcp add` in tests — the test runs without the Claude CLI installed (CI doesn't have it).
- Don't read package.json in the test to assert the version — instead, assert that the version string from the response *matches a semver regex* and is non-empty. The version is exercised; checking equality just re-reads the same file the server does.

**Implement:**
1. `tests/helpers/mcp-client.ts`: child-stdin write + stdout line buffer + response routing by `id`.
2. `tests/server.stdio.test.ts`:
   - `beforeAll`: run `npm run build` (idempotent if up-to-date).
   - test 1: `initialize` returns `{ protocolVersion, serverInfo: { name: "ticketgraph", version: /\d+\.\d+\.\d+/ } }`.
   - test 2: `tools/list` includes `tickets.ping` with the expected description prefix.
   - test 3: `tools/call({ name: "tickets.ping" })` returns content where the parsed JSON is `{ ok: true, version: /\d+\.\d+\.\d+/ }`.

**Verify:** `npm test -- tests/server.stdio.test.ts` exits 0 with three passing tests.

---

## Task 6: SIGTERM/SIGINT regression test

**Files:**
- Create: `tests/server.shutdown.test.ts`

**Decisions:**
- Spawn the server, wait for it to log "ticketgraph starting" on stderr, send `SIGTERM`, assert the child exits with code 0 within 1 second.
- Repeat with `SIGINT` (one test per signal).
- Asserting "exits within 1 second" guards against the SIGINT bug where servers ignore Ctrl-C because they never bound a handler.

**Don't:**
- Don't `kill -9` and call it a graceful shutdown — that's a different test. The signal under test must be one the server can handle.

**Implement:** Two cases (SIGTERM, SIGINT), each spawning + waiting + signalling + asserting exit code 0 + exit within 1s.

**Verify:** `npm test -- tests/server.shutdown.test.ts` exits 0 with two passing tests.

---

## Task 7: Full acceptance gate

**Files:** (none — verification only)

**Decisions:**
- All three acceptance criteria from `.ai/TICKETS.md` T2 must pass.

**Implement:** Run the verification commands.

**Verify:**
1. `npm run build && npm test` → exit 0. All tests green (logger + ping handler + version helper + stdio smoke + shutdown).
2. `node dist/server.js --help` still works (T1 gate not regressed).
3. Manually: spawn the built server in another shell, send the same initialize / tools/list / tools/call sequence by hand (or trust the integration test as proof). Document this in the task as "covered by integration test" if not running manually.
4. (Out of band — not required to close the ticket) `claude mcp add ticketgraph -s user -- node $(pwd)/dist/server.js` then call `tickets.ping()` from a Claude session. Defer this to the moment T5 lands and we want a live end-to-end check.

---

## Caveats & known risks

- **SDK API churn:** `@modelcontextprotocol/sdk` is on 1.29.x today. If the import paths in Task 4 don't resolve, check the installed SDK's `package.json#exports` field and adjust — the structure is `@modelcontextprotocol/sdk/server/index.js`, `@modelcontextprotocol/sdk/server/stdio.js`, `@modelcontextprotocol/sdk/types.js`. If they've moved, update both the plan and the implementation in the same commit.
- **stdio framing bugs are hard to debug:** if the integration test hangs, suspect a stray `console.log` somewhere. Grep the codebase: `console\.(log|info|warn|debug)`. Zero hits is the invariant.
- **`npm run build` from within a vitest test:** runs once per test file via `beforeAll`. If multiple integration files repeat the build, switch to a `globalSetup` in T5+ when more files appear.
- **Process-leak risk:** if `afterEach` fails to clean up children, parallel vitest runs will leave zombie node processes. Use `child.kill()` + a 1s `setTimeout` fallback + `child.kill('SIGKILL')`.
- **Windows is out of scope** — the spec is mac/linux only. Don't add Windows-specific signal handling.

---

## Validation review

(none — no Opus escalation triggers fired: no security/perf/concurrency load-bearing concerns, plenty of sibling MCP examples in the SDK docs, verification harness is a small JSON-RPC client.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier + code-reviewer subagents, fresh context)
**Branch:** main (T2 unstaged at review time)

### Verification Results
- `npm run build` → exit 0; `dist/server.js` 3.74 KB.
- `npm test` → exit 0; **13/13 tests** across 5 files (logger 3, version 2, ping 3, stdio integration 3, shutdown 2).
- `npm run typecheck` → exit 0.
- `node dist/server.js --help` → exit 0; prints usage stub (T1 gate preserved).
- `grep -rn 'console\.' src/ tests/` → 0 hits.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | Startup log fired after `server.connect()` rather than before | Deviation | Fixed in-line — moved log above `connect()` |
| 2 | Shutdown test waited for any stderr byte, not the "starting" line specifically | Deviation | Fixed in-line — buffer + substring check |
| 3 | `pid` param to `waitForExit` was unused | Critical (quality) | Fixed — dropped param, callers updated |
| 4 | `sendRequest` listener model wasn't documented | Critical (quality) | Fixed — added contract docstring |
| 5 | Tool shape would force every future tool to recast `unknown` | Suggested (quality) | Fixed — introduced `Tool<TArgs, TResult>` interface in `src/tools/types.ts`; `pingTool` migrated; server now calls `tool.parseArgs(...)` before `tool.handle(...)` |
| 6 | `shutdown()` called `process.exit(0)` unconditionally even if `server.close()` rejected | Suggested (quality) | Fixed — wrapped in try/catch, log on error, exit anyway |
| 7 | No `unhandledRejection` / `uncaughtException` handlers | Suggested (quality) | Fixed — handlers log to stderr; do NOT exit (let SDK return errors to client) |
| 8 | `version.ts` reads package.json eagerly at module import | Suggested (quality) | Deferred — current behaviour is fine; revisit if it bites |
| 9 | `_nextId` module-scoped state in mcp-client | Nit | Deferred — not a bug |
| 10 | `logger.ts` duplicated info/error structure | Nit | Deferred — 15 lines, fine |

### Technical Context & Learnings
- **MCP SDK exports (1.29.x) resolve via `package.json#exports`'s `"./*"` wildcard mapping to `./dist/esm/*`.** Imports `@modelcontextprotocol/sdk/server/index.js`, `.../server/stdio.js`, `.../types.js` all work without subpath listing.
- **stdout discipline is enforced by zero-tolerance grep.** `console.*` must remain zero in src/ and tests/. The logger module is the only legal stderr-writer.
- **`--help` gate must remain dependency-free** — sits above all SDK imports so it short-circuits before any heavy import work.
- **Tool registration pattern** (`Tool<TArgs, TResult>` with `parseArgs` + `handle`) is now set. T5/T7 should follow it: implement validators in `parseArgs`, throw `McpError(InvalidParams, …)` on shape problems, keep `handle()` operating on already-typed input.
- **Shutdown handler hardening**: never let `server.close()` rejection prevent `process.exit(0)`. SIGINT/SIGTERM must always exit fast.

### Items Requiring Rework
None.

### Deferred/Skipped Items
- `version.ts` lazy resolution (current eager IIFE is fine while the path is stable).
- `_nextId` module state in mcp-client (correct for current single-request use).
- `log(level, msg, meta)` helper to dedupe logger.ts (defer until a third level appears).
- `rpcResult(resp)` helper in integration tests (defer until a third integration file appears).
