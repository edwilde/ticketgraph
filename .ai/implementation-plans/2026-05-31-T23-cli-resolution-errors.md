# T23 — CLI project resolution + error & exit-code mapping — Implementation Plan

> **For the implementer:** Use `subagent-driven-development`. TDD throughout. Builds directly on the T22 CLI core (`src/cli/*`, all green at 563 tests).

**Goal:** Make CLI errors clean and correctly coded — `McpError` (usage/input) → exit 2 not 1; `openDb`/runtime failures → exit 1 with a one-line message (no stack, no unhandled rejection); and suppress the server's `INFO` log chatter on the CLI path so stderr is clean for humans and pipes.
**Architecture:** Small, surgical changes to three files — `src/cli/dispatch.ts` (error→code mapping), `src/cli/index.ts` (openDb guard + log-quiet toggle + `--verbose`), `src/logger.ts` (a quiet gate for `info`). No new modules.
**Tech Stack:** TypeScript strict, vitest, better-sqlite3, `@modelcontextprotocol/sdk` (`McpError`, `ErrorCode`).

---

## Ticket-scoped context (verified against the just-built code)

- **`dispatch.ts`** currently maps: `FlagParseError`→2, any other throw (incl. `McpError`)→1, success→0 (`dispatch.ts:44-57`). The single source of error text is `messageOf(err)` (message only, no stack). 
- **`index.ts`** calls `openDb()` at `index.ts:51` **before** the `try` (line 52). If `openDb` throws (stale-DB guard at `db.ts:62-66/96-102`, or SQLITE_BUSY), it escapes `runCli` as a rejected promise → `server.ts`'s CLI `.catch` logs `"cli fatal"` and exits 1. That's an ugly path (a log line that looks like a crash) for what is an environment error.
- **`logger.info`/`logger.error`** (`logger.ts`) both write to stderr unconditionally. `openDb`→`applyMigrations` emits `INFO migrations: applied …` (`db.ts:155`) on **every** open — including every CLI invocation. The MCP server legitimately wants stderr info logs (stdout is its protocol channel); the CLI does not.
- **Project resolution:** `requireProject(db,{project?,allowAll?},getClientRoots)` resolves explicit `project` else `[...roots, process.cwd()]`. `resolveProjectForDir` matches a registered project when its `root_path` equals cwd **or is a prefix of cwd** (`projects.ts:57`). **So running from any subdirectory of a registered project already resolves via cwd** — no git-root walk-up needed. With `NO_ROOTS` the CLI already gets correct cwd scoping. The T22 CLI already passes `NO_ROOTS`.
- **`McpError`** (`@modelcontextprotocol/sdk/types.js`) is thrown by every tool's `parseArgs`/`requireProject` for bad input — always `ErrorCode.InvalidParams` (and `MethodNotFound` only at the server's dispatch layer, which the CLI doesn't use). It carries a numeric `.code`. Every tool McpError is a *usage/input* error.

---

## Task 1: Map `McpError` → exit 2 in dispatch

**Files:** Modify `src/cli/dispatch.ts`; extend `src/cli/dispatch.test.ts`.

**Decisions:**
- Import `{ McpError } from "@modelcontextprotocol/sdk/types.js"`. In the catch around `parseArgs`/`handle` (`dispatch.ts:55-57`), map `err instanceof McpError` → code **2** (it is a usage/input error: bad args, unknown project, not-found id supplied by the user); all other throws → code **1** (genuine runtime/internal). Message-only output is unchanged.
- **Map ALL `McpError` → 2**, not just `InvalidParams`, *because* every `McpError` reachable from a tool's `parseArgs`/`handle` is an input/usage fault (the tools only ever throw `InvalidParams`; `MethodNotFound` would also be usage). This keeps the rule one line and matches the ticket's "InvalidParams/MethodNotFound → 2" intent without brittle code-number matching.
- The `resolveRawArgs` catch (`dispatch.ts:44-49`) already maps `FlagParseError`→2 and other→1; leave it. (A `McpError` cannot originate there — `resolveRawArgs` does no tool validation.)

**Don't:**
- Don't match on `err.code` numbers — `instanceof McpError` is clearer and the tools only emit usage-class codes. (If a future tool throws a non-usage `McpError`, revisit — note it.)
- Don't change the message format (still `messageOf`, no stack).

**Verify (test-first):** red test — a tool whose `parseArgs` throws `McpError(InvalidParams)` (e.g. `get` with neither id nor ids, or `list` with a bad limit) now returns code **2** (was 1); a tool whose `handle` throws a plain `Error` still returns **1**; `get NOPE` (missing ticket → `McpError`) returns **2**. (Note: this tightens the T22 spawn test's bullet-10 expectation — `get NOPE` now exits **2**, not 1, because "ticket not found" is an `McpError(InvalidParams)`. Update that spawn assertion in this task.)

---

## Task 2: Guard `openDb` failure + the exit-code matrix in `runCli`

**Files:** Modify `src/cli/index.ts`; extend `src/cli/index.test.ts`.

**Decisions:**
- Move `openDb()` **inside** a try so a throw becomes a clean returned code, not an unhandled rejection. On `openDb` failure: write `err.message` (one line, no stack) to stderr, return **1** (environment/runtime — a stale or busy DB is not a usage error). Keep the existing `finally { db.close() }` but guard it (only close if `db` was assigned — a failed `openDb` has no handle).
- Resolution needs **no code change** — `NO_ROOTS`→cwd with prefix-matching already resolves subdirectories. Document this (and that explicit `--project` / `--project all` flow through `requireProject` unchanged). Do NOT add a git-root walk-up (redundant).

**Don't:**
- Don't double-close: a failed `openDb` returns before a handle exists; structure the try so `finally` only closes an opened handle (e.g. open inside try, `let db` declared outside, `if (db) db.close()` in finally).
- Don't swallow the message — a stale-DB error must still tell the user what's wrong (it carries actionable text from `db.ts`).

**Verify (test-first):** red tests — running a known command against a `TICKETGRAPH_DB_PATH` pointing at a deliberately stale/half-init DB returns **1** with the stale-DB message on stderr (no stack, nothing on stdout); the happy path is unaffected (still 0). Confirm the exit-code matrix end-to-end: success 0, unknown command 2, validation/`McpError` 2 (via Task 1), env error 1.

---

## Task 3: Suppress CLI `INFO` chatter (`--verbose` / `TICKETGRAPH_DEBUG` re-enable)

**Files:** Modify `src/logger.ts` (quiet gate) and `src/cli/index.ts` (enable quiet on the CLI path); add/extend tests in `src/logger.test.ts` and `src/cli/index.test.ts`.

**Decisions:**
- Add a module-level quiet flag to `logger.ts`: `let quiet = false; export function setQuiet(v: boolean) { quiet = v; }`. `info()` returns early when `quiet` is true; **`error()` always writes** (real errors must surface even in quiet mode).
- In `runCli`, **before** `openDb()`: enable quiet unless the user asked for logs — `logger.setQuiet(!(argv.includes("--verbose") || process.env.TICKETGRAPH_DEBUG))`. This keeps the migration `INFO` line (and any future info logs) off CLI stderr by default, while the **MCP server path never calls `setQuiet`** so its stderr logging is unchanged.
- Treat `--verbose` as a global flag (like `--help`): recognised anywhere in argv, and **stripped from argv** before command/flag parsing so it isn't mis-parsed as a tool flag. Document the same caveat as `--help` (a literal value equal to `--verbose` is not supported; no tool needs one).

**Don't:**
- Don't gate `error()` behind quiet — only `info()`. A suppressed error would hide real failures.
- Don't set quiet in `server.ts`/`main()` — the MCP server's info-to-stderr behaviour must not regress (its stdio tests don't assert on info lines, but the design reserves stderr for diagnostics there).
- Don't strip `--verbose` only when it's `argv[0]` — it's a global, can appear after the command; strip all standalone occurrences (mirror `--help`'s `argv.includes`).

**Verify (test-first):** red tests — `logger.info` writes nothing after `setQuiet(true)` and `logger.error` still writes; a CLI run (`runCli`) produces **no `INFO` line** on stderr by default but DOES when `--verbose` is passed or `TICKETGRAPH_DEBUG` is set; `--verbose` is stripped (a command with `--verbose` still parses its real flags correctly). Capture stderr via a spy on `process.stderr.write`.

---

## Caveats & known risks (the adversarial pass, pre-empted)

- **Task 1 tightens an existing test.** `get <missing-id>` now exits **2** (McpError=usage), not 1. The T22 spawn test bullet-10 asserted exit 1 — update it in Task 1, and re-justify: "not found" for a user-supplied id is an input error (exit 2), consistent with unknown-command/bad-flag. This is the intended T23 behaviour, not a regression.
- **`instanceof McpError` across module instances.** `dispatch.ts` and the tools must import `McpError` from the same `@modelcontextprotocol/sdk/types.js` (single dependency instance under tsup `external` + one node_modules) — confirm the `instanceof` actually matches (a test throwing a real tool `McpError` proves it). If bundling ever duplicated the SDK, `instanceof` would silently fail → the test is the guard.
- **`--verbose` global-flag collision** with a hypothetical tool flag/value named `--verbose`: none exists today; documented limitation, same class as `--help`.
- **Quiet is process-global module state.** Fine for a one-shot CLI process; in unit tests, reset it in `afterEach` (`setQuiet(false)`) so a quiet-enabling test doesn't leak into later tests that assert on info output.
- **openDb-before-try double-close**: the failure mode is closing an unassigned handle; the `let db; try { ({db,dbPath}=openDb()) … } finally { db?.close() }` shape avoids it. Verify no double-close on the success path either.

---

## Validation review

Adversarial review scaled to ticket risk: the three highest-risk items (the existing-test tightening from McpError→2, cross-module `instanceof McpError`, and quiet-state leakage) are pre-empted as Caveats above and covered by named tests. A post-implementation code-review gate (fresh Opus subagent) runs after the build, as for T22.

---

## Review record

**Reviewed:** 2026-05-31 (fresh-context Opus implementer + Sonnet code-review gate)
**Verification:** build ✓, typecheck ✓, `npm test` **571 passed / 54 files** (+8 over T22's 563).

### Result: APPROVED. No Blocking; two Important findings accepted as-is (both guard hypothetical future code), four Notes deferred.

**Built as planned:**
- `McpError`→exit 2 via `instanceof` (`dispatch.ts`), proven cross-module by a test that throws a *real* tool `McpError` (`get` with no id/ids). Non-`McpError` runtime → 1.
- `openDb()` moved inside `runCli`'s try; failure → one-line stderr + exit 1 (no unhandled rejection); `let db: …|undefined` + `db?.close()` finally → no double-close on either path.
- `logger.setQuiet` gate: `info()` suppressed on the CLI path by default, `error()` never gated; re-enabled by `--verbose` (global flag, stripped from argv) or `TICKETGRAPH_DEBUG`. `server.ts`/`main()` untouched.
- Git-root walk-up **dropped as redundant** (cwd prefix-matching in `resolveProjectForDir` already resolves subdirectories) — documented in `index.ts`.
- T22 spawn bullet-10 tightened: `get <missing-id>` now exits **2** (a user-supplied not-found id is an input error), with an updated rationale comment.

**Reviewer findings — decisions:**
| # | Finding | Severity | Decision |
|---|---------|----------|----------|
| 1 | `--verbose` stripped by value-equality could in theory shadow a literal `--verbose` value | Important | Accepted — cannot fire: a `--verbose` *value* only arrives via the `=` form (`--x=--verbose`, not stripped); the space form is rejected by the flag parser. Same documented class as the `--help` global flag. |
| 2 | All `McpError`→2 regardless of `.code`; a future `InternalError` would mis-code as usage | Important | Accepted as-is — correct for every current tool (all throw `InvalidParams`); the plan deliberately chose `instanceof` over brittle code-matching (simplicity-first). **Revisit if any tool ever throws a non-usage `McpError`.** |
| 3 | "always InvalidParams" is a codebase assertion, not an SDK guarantee | Note | Acknowledged (same as #2). |
| 4 | `isJsonHatch` bare-`--json` clause non-obvious | Note | Skipped (cosmetic). |
| 5 | boolean `--key=value` ignores the value | Note | Skipped — booleans are presence-only by design; no tool has a negatable boolean. |
| 6 | CLI opens write-mode for read commands | Note | Not a T23 issue — write-mode-always was T22's deliberate decision (read-only `openDb` throws on pending migrations); `busy_timeout` mitigates contention. |

### Items requiring rework
None.

### Learnings
- Subdirectory project resolution is free via `resolveProjectForDir`'s prefix-matching — no git-root logic needed in the CLI.
- The exit-code contract is now: 0 success · 2 usage (`McpError`, unknown command/flag, bad `--json`) · 1 runtime/environment (`openDb` failure, non-usage throws).
- CLI stderr is clean by default; `--verbose`/`TICKETGRAPH_DEBUG` restores the server-style `INFO` diagnostics.
