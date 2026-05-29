# T11 — Plugin manifest and install path

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Make ticketgraph installable as a Claude Code plugin (auto-registering its MCP server) and document the local dev-install path, so a fresh `git clone` reaches a working `tickets.ping` in <5 minutes.
**Architecture:** A `.claude-plugin/plugin.json` (metadata) + a root `.mcp.json` declaring the stdio server via `${CLAUDE_PLUGIN_ROOT}/dist/server.js`. An `npm run setup` script that registers the server for non-plugin dev use via `claude mcp add`. Install docs in `docs/install.md`.
**Tech Stack:** JSON manifests, a small Node setup script. No runtime deps.

---

## Ticket-scoped context (authoritative format, confirmed via Claude Code docs)

- **Plugin manifest lives at `.claude-plugin/plugin.json`** (canonical today), NOT root `plugin.json`. The design spec §9 says "plugin.json at repo root" — that wording predates the current convention. Follow `.claude-plugin/plugin.json`; note the deviation in the review record.
  - Required fields: `name`, `description`. Optional: `version`, `author`, `license`, `repository`, `homepage`, `keywords`.
  - `name: "ticketgraph"` (this namespaces any future skills as `/ticketgraph:<skill>`).
- **The bundled MCP server is declared in a root `.mcp.json`** (canonical) with:
  ```json
  { "mcpServers": { "ticketgraph": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"] } } }
  ```
  - `${CLAUDE_PLUGIN_ROOT}` resolves at runtime to the plugin's install dir.
  - stdio is the default transport — no `type` field needed.
  - When the plugin is installed + enabled, this server **auto-starts** — the user does NOT run `claude mcp add`. `/reload-plugins` refreshes after edits.
- **Dev-install path (no marketplace, local iteration)** — two routes, both documented:
  1. **Plugin dev mode:** `claude --plugin-dir /abs/path/to/ticketgraph` — loads the plugin (and its auto-registered MCP server) from the working tree. Best for iterating on the plugin.
  2. **Direct MCP registration (no plugin):** `claude mcp add --transport stdio -s user ticketgraph -- node /abs/path/to/ticketgraph/dist/server.js`. Options BEFORE the name; `--` separates them from the command. `-s user` = available in all projects (stored in `~/.claude.json`). This is what `npm run setup` automates.
- **`npm run setup`** (ticket scope: "registers the MCP with `claude mcp add` so the user doesn't run it manually"): a Node script that computes the absolute path to `dist/server.js` and runs the `claude mcp add` command. It must `npm run build` first (or check `dist/server.js` exists and tell the user to build). Idempotent-ish: if already registered, `claude mcp add` errors — catch and report "already registered" rather than failing hard.
- **Verify**: `claude mcp list` shows `ticketgraph`; `claude mcp get ticketgraph` shows details; `/mcp` in-session shows it live; calling `tickets.ping` returns `{ ok, version, db_path, schema_version }`.
- **CI caveat**: the `claude` CLI is NOT available in CI (T13). So T11's automated tests can only validate the *manifests* (valid JSON, required fields, correct server path shape) and that the setup script resolves the path correctly — NOT an actual `claude mcp add` round-trip. The <5-minute fresh-machine acceptance is a manual checklist in `docs/install.md`.

---

## Task 1: `.claude-plugin/plugin.json`

**Files:**
- Create: `.claude-plugin/plugin.json`

**Decisions:**
- Fields: `name: "ticketgraph"`, `description` (one line, matches package.json's), `version: "0.1.0"` (keep in sync with package.json), `author: { name: "Ed Wilde" }`, `license: "MIT"`, `repository: "https://github.com/edwilde/ticketgraph"`, `keywords: ["mcp", "tickets", "sqlite", "claude-code"]`.
- Do NOT inline the MCP server here — use the separate `.mcp.json` (cleaner separation; matches the OMC reference plugin on disk).

**Don't:**
- Don't put it at repo root — `.claude-plugin/plugin.json` is the canonical location.
- Don't drift `version`/`description` from package.json (note: two sources; a future ticket could derive one from the other, out of scope here).

**Implement:** Write the manifest.

**Verify:** Task 4 test asserts it's valid JSON with `name` + `description`.

---

## Task 2: root `.mcp.json`

**Files:**
- Create: `.mcp.json`

**Decisions:**
- Exactly: `{ "mcpServers": { "ticketgraph": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"] } } }`.
- `command: "node"` + explicit args (don't rely on the shebang/exec-bit for the plugin path).

**Don't:**
- Don't hardcode an absolute path — use `${CLAUDE_PLUGIN_ROOT}`.
- Don't add a `type` field — stdio is the default.
- Don't add env or other keys not needed.

**Implement:** Write `.mcp.json`.

**Verify:** Task 4 test asserts the server entry exists with `command: "node"` and an arg containing `${CLAUDE_PLUGIN_ROOT}/dist/server.js`.

---

## Task 3: `npm run setup` script

**Files:**
- Create: `scripts/setup.mjs`
- Modify: `package.json` (add `"setup": "node scripts/setup.mjs"`)

**Decisions:**
- `scripts/setup.mjs`:
  1. Resolve the repo root (the script's own dir's parent) and the absolute `dist/server.js` path.
  2. If `dist/server.js` is missing → print "Run `npm run build` first." and exit 1.
  3. Run `claude mcp add --transport stdio -s user ticketgraph -- node <absDistServer>` via `child_process.spawnSync`.
  4. On success → print the `claude mcp list` hint + how to call `tickets.ping`.
  5. If `claude` isn't on PATH → catch ENOENT, print the manual command for the user to run themselves, exit 0 (don't hard-fail; the user may not have the CLI on this shell).
  6. If `claude mcp add` exits non-zero (e.g. already registered) → print stderr + "(it may already be registered — `claude mcp list` to check)", exit 0.
- Output via `process.stdout/stderr.write` or `console` — this is a standalone CLI script, NOT the MCP server, so `console.log` is acceptable here. BUT to keep the repo-wide `grep console.` invariant clean for `src/` and `tests/`, put the script under `scripts/` (outside both) — the grep only covers `src/ tests/`. Confirm the grep scope excludes `scripts/`.

**Don't:**
- Don't fail the whole script if `claude` is absent — degrade to printing the manual command.
- Don't run `claude mcp add` without the absolute path (the server needs an absolute path when registered directly).
- Don't put the setup script in `src/` (it's not part of the server bundle; tsup must not pick it up).

**Implement:** Setup script + package.json script.

**Verify:** `node scripts/setup.mjs` on a machine without `claude` prints the manual command and exits 0. With `dist/` absent, prints the build hint. (Task 4 unit-tests the path-resolution helper if extracted; otherwise a manual check.)

---

## Task 4: Manifest validation test

**Files:**
- Create: `tests/plugin-manifest.test.ts`

**Decisions:**
- Pure JSON-shape tests (no `claude` CLI):
  - `.claude-plugin/plugin.json` parses; has non-empty `name === "ticketgraph"` and `description`.
  - `.mcp.json` parses; `mcpServers.ticketgraph.command === "node"`; `args` includes a string containing `${CLAUDE_PLUGIN_ROOT}/dist/server.js`.
  - `version` in plugin.json matches package.json's `version` (guards the documented "keep in sync" decision — a cheap drift check).
- Read the files via `readFileSync` relative to repo root.

**Don't:**
- Don't shell out to `claude` — unavailable in CI.
- Don't assert the server actually starts here — that's the existing stdio integration tests' job.

**Implement:** The validation test.

**Verify:** `npm test tests/plugin-manifest.test.ts` → passing.

---

## Task 5: `docs/install.md`

**Files:**
- Create: `docs/install.md`

**Decisions:**
- Sections:
  1. **Prerequisites** — Node ≥20, the `claude` CLI, build toolchain for better-sqlite3 (Xcode CLT on macOS).
  2. **Quick start (dev, <5 min)** — `git clone` → `npm install` → `npm run build` → `npm run setup` → restart Claude / `claude mcp list` → call `tickets.ping`. A numbered checklist matching the acceptance criterion.
  3. **Plugin install (dev mode)** — `claude --plugin-dir /abs/path` route; `/reload-plugins`.
  4. **Direct MCP registration** — the explicit `claude mcp add --transport stdio -s user ticketgraph -- node <abs>/dist/server.js` command, with scope explanation.
  5. **Future public install** — once published: marketplace/`claude plugin install` + npm `@edwilde/ticketgraph` (mark as "planned, not yet available").
  6. **Verify** — `claude mcp list`, `/mcp`, `tickets.ping`.
  7. **Uninstall** — `claude mcp remove ticketgraph`.
- T12 (README) will link here; keep install detail in this file, not duplicated in README.

**Don't:**
- Don't duplicate the full install guide into README (T12 links to this).
- Don't claim the public/marketplace path works yet — it's planned.

**Implement:** Write `docs/install.md`.

**Verify:** A reader can follow steps 1–6 to a working `tickets.ping`. (Manual; the file is prose.)

---

## Task 6: Full gate

**Verify:**
1. `npm run build` → exit 0.
2. `npm test` → exit 0; all green (incl. the new manifest test).
3. `npm run typecheck` → exit 0.
4. `grep -rn 'console\.' src/ tests/` → 0 hits (the setup script lives in `scripts/`, outside this scope — confirm).
5. `node dist/server.js --help` → exit 0.
6. Manual: `npm run setup` behaves correctly with/without `claude` on PATH and with/without `dist/`.

---

## Caveats & known risks

- **Spec §9 vs reality**: spec says root `plugin.json`; the current Claude Code convention is `.claude-plugin/plugin.json` + `.mcp.json`. We follow the working convention. If a very old Claude Code is targeted, this would differ — but we target current.
- **Two version sources**: `package.json` and `.claude-plugin/plugin.json` both carry `version`. The manifest test asserts they match to catch drift; a future ticket could generate one from the other.
- **`claude` CLI absent in CI**: T11 can't end-to-end-test registration in CI. The manifest test + manual checklist cover what's automatable; the <5-min acceptance is a documented manual run.
- **Auto-start vs manual add**: when installed AS A PLUGIN, the `.mcp.json` server auto-starts — `npm run setup`/`claude mcp add` is only for the non-plugin direct-registration dev route. `docs/install.md` must make this distinction clear so users don't double-register.
- **better-sqlite3 native build**: the fresh-machine path depends on `npm install` compiling better-sqlite3 (needs Xcode CLT on macOS). `docs/install.md` prerequisites must call this out (it's the most likely <5-min blocker).
- **`scripts/` console usage**: the setup script uses console/stdout freely (it's a CLI, not the MCP server). The repo's zero-console invariant is scoped to `src/` and `tests/` — keep the script in `scripts/` so the invariant holds.

---

## Validation review

(none — config + docs ticket; the only code is a small setup script with graceful degradation, and a JSON-shape test.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier subagent, fresh context)
**Branch:** main (unstaged at review time)

### Verification Results
- `npm run build` → exit 0; `dist/` has server + 2 parsers, NO `setup.js` (scripts/ correctly excluded from tsup entries).
- `npm test` → exit 0; **401/401 tests** across 41 files (was 394/40; +7 manifest tests). Verified 6/6 stable after the timeout fix below.
- `npm run typecheck` → exit 0.
- `grep -rn 'console\.' src/ tests/` → 0 hits (setup script lives in `scripts/`, outside scope).
- `node scripts/setup.mjs` registered successfully in an env with `claude` present + `dist/` built.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | All 33 criteria (manifests, setup script, install docs, no-double-register distinction) | Completed as planned | Verified, no gaps |
| 2 | `.claude-plugin/plugin.json` + `.mcp.json` instead of spec §9's "root plugin.json" | Deviation | Approved — current Claude Code convention, confirmed via docs |
| 3 | **stdio test `it` blocks had no explicit timeout (default 5s) while `waitForServerReady` budgets 10s** | Deviation (BUG, self-introduced in T9 hardening) | **Fixed** — added 20s timeouts to the 3 stdio `it`s; the T9-era `waitForServerReady` addition needs the test timeout to exceed its internal budget |

### Technical Context & Learnings
- **Claude Code plugin packaging**: metadata in `.claude-plugin/plugin.json` (name + description required); the bundled MCP server is declared in a root `.mcp.json` with `command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"]`. Installed-as-plugin → the server **auto-starts** (no manual `claude mcp add`). The `npm run setup` / direct `claude mcp add --transport stdio -s user ticketgraph -- node <abs>` route is ONLY for non-plugin dev use. `docs/install.md` documents both and warns against double-registration.
- **Test-timeout invariant**: any `it` that calls `waitForServerReady` (10s internal budget) MUST set an explicit vitest timeout > 10s (we use 20s). The default 5s vitest test timeout is shorter than the readiness budget and will spuriously fail under load. The tools-test `it`s already had 15s/30s; the stdio ones didn't.
- **`scripts/` is outside the zero-console invariant** (which covers `src/` + `tests/`). Standalone CLIs like `setup.mjs` may use console; they must not be picked up as tsup entries.

### Items Requiring Rework
None.

### Deferred/Skipped Items
- Single source of truth for `version` (currently package.json + plugin.json, drift-guarded by a test).
- **Surfaced during review (now T14):** `process.cwd()`-based project resolution is wrong for a persistent global server — must resolve from MCP client roots. Tracked separately.
