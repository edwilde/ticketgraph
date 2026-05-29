# T18 — Orphaned MCP server processes (stdin-close shutdown + non-blocking shutdown)

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Stop the global stdio MCP server from leaking orphaned `node dist/server.js` processes. Two fixes in `src/server.ts`: (1) exit when stdin closes (the parent session is gone), and (2) make `shutdown()` non-blocking-safe so a hung `server.close()` can never wedge the process (which currently also defeats SIGTERM via the `shuttingDown` guard).
**Architecture:** `src/server.ts` only — add stdin `end`/`close` + `SIGHUP` handlers wired to the existing `shutdown()`, and arm an unref'd failsafe timer inside `shutdown()` before the awaited close. Plus integration tests. No new features, no schema/tool changes.
**Tech Stack:** TypeScript ESM, `@modelcontextprotocol/sdk` StdioServerTransport, Node child_process tests.

---

## Ticket-scoped context (the bug, from the live diagnosis)

- **Symptom:** ~60 orphaned `node dist/server.js` processes (~180 MB each, ≈10 GB RAM) reparented to launchd (`ppid 1`), accumulated over days; `kernel_task` CPU saturation, swap thrash, load avg ~520. `pkill`/SIGTERM did NOT reap them — only `kill -9` did (that's itself a symptom — see defect 2).
- **Two compounding defects:**
  1. **No stdin-EOF shutdown.** The server only handles `SIGTERM`/`SIGINT`. When the parent Claude session exits it closes the stdio pipes but doesn't reliably signal the child; with no `process.stdin` `end`/`close` handler the orphan runs forever and reparents to launchd. A stdio MCP server with no live parent has no reason to keep running.
  2. **`shutdown()` can hang and defeats SIGTERM.** `shutdown()` sets `shuttingDown = true`, then `await server.close()`. For an orphan whose transport pipe is already dead, `server.close()` may never resolve, so `process.exit(0)` is never reached — and because the guard is already set, every subsequent SIGTERM is a no-op. The process is wedged half-shut, immune to normal kills.
- **Compounded by global registration** (`~/.claude.json`, user scope) — every Claude session anywhere spawns one, so leaks accumulate across all projects. **Do NOT narrow the registration scope** (it's intentional, spec §3); the fix is correct lifecycle.
- **Current `shutdown()`** (`src/server.ts`): guard → `db?.close()` (best-effort) → `await server.close()` (can hang) → `process.exit(0)`. Wired to SIGTERM/SIGINT in `main()` after `server.connect(transport)`.
- **StdioServerTransport reads `process.stdin`.** Adding `end`/`close` *event* listeners (not `data` consumers) does NOT interfere with the transport's reading — they're lifecycle events. The transport may fire its own onclose, but nothing currently calls `process.exit` on it, so the process lingers.

---

## Task 1: non-blocking-safe `shutdown()`

**Files:**
- Modify: `src/server.ts`

**Decisions:**
- At the very top of `shutdown()` (after setting the `shuttingDown` guard), arm a hard failsafe:
  ```ts
  const failsafe = setTimeout(() => process.exit(0), 1000);
  failsafe.unref();
  ```
  `unref()` so the timer itself never keeps the event loop alive — it only *forces* exit if the awaited close hangs past 1 s. If close is fast, `process.exit(0)` at the end runs first and the unref'd timer is moot.
- Keep `db?.close()` and `await server.close()` best-effort (try/catch, log on error) exactly as now; they just can no longer wedge the process.
- The final `process.exit(0)` stays.
- This means: once `shutdown()` is entered, the process WILL exit within ~1 s regardless of what `server.close()` does. That also fixes defect 2's "guard set + hung close = immune to SIGTERM" — the failsafe guarantees exit.

**Don't:**
- Don't remove the `shuttingDown` guard (still want idempotency for double-signal), but don't let it strand the process — the failsafe is what makes the guard safe.
- Don't make the failsafe `ref`'d (would keep an idle server alive 1 s longer for no reason and could mask other event-loop issues).
- Don't change `db.close()`/`server.close()` ordering or their best-effort try/catch.

**Implement:** Add the unref'd failsafe timer at the start of `shutdown()`.

**Verify:** Existing SIGTERM/SIGINT graceful-shutdown tests stay green (clean path still exits 0); new tests in Task 3.

---

## Task 2: stdin-close + SIGHUP shutdown

**Files:**
- Modify: `src/server.ts` (in `main()`, after `server.connect(transport)`)

**Decisions:**
- After the transport connects, wire parent-gone signals to the same `shutdown()`:
  ```ts
  process.stdin.on("end", () => void shutdown(server, db));
  process.stdin.on("close", () => void shutdown(server, db));
  process.on("SIGHUP", () => void shutdown(server, db));
  ```
- Place these AFTER `server.connect(transport)` so the transport has already set up its stdin handling; our listeners are additive lifecycle listeners.
- `end` fires on stdin EOF (parent closed the write end — the normal "Claude session exited" case). `close` covers fd close. `SIGHUP` covers terminal/parent hangup.
- All route through the existing idempotent `shutdown()` (guard prevents double-run; failsafe guarantees exit).

**Don't:**
- Don't attach a `data` listener to stdin (would steal bytes from the transport). Only `end`/`close`.
- Don't call `process.exit` directly from these handlers — go through `shutdown()` so db/server close cleanly when possible.
- Don't attach before `server.connect` (let the transport initialise stdin first).

**Implement:** Add the three handlers after `server.connect(transport)`.

**Verify:** New integration test in Task 3 (stdin close → exit).

---

## Task 3: tests

**Files:**
- Modify: `tests/server.shutdown.test.ts` (add a stdin-close case; reuse the existing temp-DB + readiness pattern)

**Decisions:**
- **New case — stdin close → exit:** spawn the built server with a temp `TICKETGRAPH_DB_PATH`; wait for the `"ticketgraph starting"` stderr line (readiness); then `child.stdin.end()` (closes the write end → child sees stdin EOF → `end` handler → shutdown → exit). Assert the child exits within a generous bound (per the established timing rules: internal wait ≤ vitest it-timeout; use ~5 s internal SIGKILL fallback + 15 s `it` timeout). Assert exit code 0 (clean shutdown via the `end` path).
- **Keep the existing SIGTERM/SIGINT cases** — they prove the failsafe didn't break the clean path (still exit 0). Their generous 12 s/15 s bounds stay (do NOT tighten — the timing-flake history).
- The "hung `server.close()`" path is hard to reproduce from a spawned process (can't force the SDK's close to hang). It's covered by the unref'd-failsafe design + the SIGTERM cases proving clean exit; document this in a test comment rather than fabricate a hang. (A unit test of `shutdown()` in isolation isn't worth exposing the private fn for; the integration coverage is sufficient.)
- Reuse the `waitForServerReady`-style stderr wait already used by the spawn tests; capture the child in a local (per the SIGKILL-timer lesson) so cleanup can't kill a later test's process.

**Don't:**
- Don't tighten the existing shutdown bounds (12 s/15 s) — that flaked before.
- Don't assert a tight sub-second exit for the stdin-close case under parallel load — use a generous bound (catches "never exits" = the bug, tolerates loaded scheduling).
- Don't fabricate a `server.close()` hang with brittle mocking.

**Implement:** Add the stdin-close integration case with generous bounds + a local-captured child.

**Verify:** `npm test tests/server.shutdown.test.ts` → stdin-close + SIGTERM + SIGINT all green; run the full suite twice to confirm no flake.

---

## Task 4: commit the T18 ticket + full gate

**Files:**
- `.ai/TICKETS.md` already carries the T18 ticket (authored by the diagnosing session) in the working tree — include it in this branch's commit so the ticket definition lands with its fix. Also flip T15 → Done and T18 → Done in the status table as part of this commit (T15 is merged; T18 completes here). **Re-read TICKETS.md immediately before editing** in case it changed, and make a surgical edit (the repo had concurrent edits).

**Decisions:**
- The status table currently (per the diagnosing session's edit) lists Open: `T15, T18`. After this work: T15 and T18 are Done. Move both to Done, leave Open as `_(none)_`.

**Verify:**
1. `npm run build` → exit 0.
2. `npm test` → exit 0; all green (existing + new stdin-close case). Run twice.
3. `npm run typecheck` → exit 0.
4. `node dist/server.js --help` → exit 0.
5. `grep -rn 'console\.' src/ tests/` → 0 hits.
6. **Manual leak check (the real acceptance):** `node dist/server.js` with stdin from a pipe, then close stdin → process exits (no orphan). Or: spawn, init, end stdin, confirm `ps` shows no lingering pid.

---

## Caveats & known risks

- **stdin listeners vs transport:** `end`/`close` are lifecycle events, not `data` — safe alongside StdioServerTransport. If the SDK version changes how it consumes stdin, re-verify the `end` event still fires on parent-pipe close (the integration test guards this).
- **Failsafe timing:** 1 s is enough for a clean `db.close()`/`server.close()`; if close legitimately takes >1 s the failsafe could cut it short — acceptable, since the alternative is a wedged immortal process, and `db.close()` on SQLite is effectively instant. Audit integrity is unaffected (writes are already committed per-transaction; shutdown isn't mid-write).
- **Existing orphans** are not killed by this code (already SIGKILL'd operationally during the session). The fix prevents NEW ones. The T18 ticket notes the one-time cleanup command.
- **Don't narrow registration scope** — global user-scope is intentional; the fix is lifecycle correctness so the global registration is safe.
- **Timing-flake discipline:** the new stdin-close test must use generous bounds tied to the it-timeout, like the other spawn tests — never a tight latency assertion.
- **Concurrent TICKETS.md edits:** the repo had two sessions editing TICKETS.md; re-read before the status-table edit and keep it surgical.

---

## Validation review

(none — two small, well-understood lifecycle fixes in one file; the only subtlety is not stealing stdin bytes from the transport, addressed by using `end`/`close` events only, and the generous test bounds.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier subagent, fresh context)
**Branch:** fix/t18-server-lifecycle

### Verification Results
- `npm run build` → 0. `npm test` → 0; **439/439** across 43 files, **green on two consecutive runs** (no flake). `npm run typecheck` → 0. `--help` → 0. `grep console.` → 0.
- `grep stdin.*data src/server.ts` → 0 (no byte-stealing data listener).
- Manual leak check: `node dist/server.js < /dev/null` → "ticketgraph starting" → "ticketgraph shutting down" → exit 0 (no orphan).
- `server.stdio.test.ts` + `server.tools.test.ts` green → legit clients holding stdin open are NOT prematurely shut down.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | All 18 criteria (unref'd failsafe before await; end/close+SIGHUP after connect; no data listener; new stdin-close test; existing bounds intact; surgical TICKETS.md) | Completed as planned | Verified |
| 2 | SIGHUP may not be delivered under launchd on macOS | Suggested (note) | Accepted — the stdin `end`/`close` path is the reliable guard for the actual failure mode; SIGHUP is belt-and-suspenders |

### Technical Context & Learnings
- **The leak had two compounding defects**: (1) no stdin-EOF handler → an orphaned stdio server runs forever after its parent session exits; (2) `shutdown()` could hang on `await server.close()` for a dead transport, and the `shuttingDown` guard then made SIGTERM a no-op → wedged, immortal, `kill -9`-only. ~60 orphans / ~10 GB RAM in the live incident.
- **Fix 1 — unref'd failsafe**: `setTimeout(() => process.exit(0), 1000).unref()` armed at the top of `shutdown()`. Guarantees exit within ~1s no matter what `server.close()` does; also neutralises the wedged-guard-vs-SIGTERM problem. `unref()` is essential — a ref'd timer would keep an idle server alive.
- **Fix 2 — stdin lifecycle**: `process.stdin.on("end"/"close")` + `SIGHUP` → `shutdown()`, wired AFTER `server.connect(transport)`. **Use lifecycle events only, never a `data` listener** (that would steal bytes from StdioServerTransport and break the protocol). 'end' fires on parent-pipe EOF = "Claude session exited".
- **No premature shutdown**: a live client (Claude Code) holds stdin open, so end/close only fire on real session exit — confirmed by the stdio/tools integration tests staying green.
- Global user-scope registration is intentional (spec §3); the fix is lifecycle correctness, not narrower scope.

### Items Requiring Rework
None.

### Deferred/Skipped Items
- Forcing/asserting a `server.close()` hang in tests — can't reproduce the SDK hang cleanly; covered by the unref'd-failsafe design + the SIGTERM cases proving clean exit. Documented in a test comment.
