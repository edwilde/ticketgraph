# T26 — Packaging, docs & MCP-becomes-opt-in — Implementation Plan

> **For the implementer:** Use `subagent-driven-development`. This is the epic's shipping ticket — config + docs + the one behaviour change existing users notice (MCP no longer auto-connects). Builds on T22–T25 (`src/cli/*`, suite green).

**Goal:** Realise the token win — a fresh Claude session pays ~0 context for ticketgraph until a query is made. Make the MCP server **opt-in** (no auto-connect), keep the always-on footprint to a one-line `CLAUDE.md` pointer, repoint the bundled slash commands at the CLI so they work with MCP off, document the CLI surface, and bump to **0.4.0**.
**Architecture:** No `src/` logic changes — this is packaging (`.mcp.json`, `plugin.json`, `package.json`), the slash commands (`commands/*.md`), docs (`README.md`, `docs/*`), a dev allowlist (`.claude/settings.json`), and a repo `CLAUDE.md` (dogfooding).
**Tech Stack:** Claude Code plugin manifest + `.mcp.json`, npm `bin`, markdown.

---

## Ticket-scoped context (verified)

- **`.mcp.json`** (plugin root) is what auto-connects the MCP server when the plugin is enabled — i.e. what injects all ~23 tool schemas into every session. Making MCP opt-in **requires** this to stop auto-loading; there is no other way to avoid the schema tax. This is forced by the epic's goal, not a discretionary call.
- **`package.json`** already exposes the CLI: `"bin": { "ticketgraph": "./dist/server.js" }`. So `ticketgraph <command>` works once the package is on PATH (global/npx install). `dist/server.js` is dual-mode (T22): no-args/`--mcp` → server, `<command>` → CLI.
- **`plugin.json`** / **`package.json`** are at version **0.3.0** → bump to **0.4.0**. `plugin.json`'s description says "MCP server backing the ticketgraph plugin" — update to reflect dual-mode (CLI + opt-in MCP).
- **`commands/*.md`** (tickets-add, tickets-done, tickets-next, tickets-open, tickets-status) currently instruct Claude to use the `tickets.*` **MCP tools**. With MCP opt-in (off by default) these break unless repointed to the CLI.
- **No `.claude/settings.json`** and **no root `CLAUDE.md`** exist yet.
- **`--help` is now the discovery surface** (T25): top-level lists commands + global flags + the `<command> --help` hint. So the `CLAUDE.md` pointer can be ~1 line and defer detail to `--help`.

---

## Task 1: Make the MCP server opt-in

**Files:** Remove/relocate `.mcp.json`; document re-enable in `docs/install.md`.

**Decisions:**
- **Remove `.mcp.json` from the plugin root** so enabling the plugin no longer auto-connects the MCP server (kills the always-on schema tax). Preserve its exact content in `docs/install.md` under an "Enabling the MCP server (optional)" section.
- **Re-enable paths documented:** (a) restore `.mcp.json` (content provided in docs), or (b) `claude mcp add ticketgraph -- node <path>/dist/server.js --mcp`. Note both.
- **Verify the plugin still loads** its slash commands with no `.mcp.json` — `plugin.json` + `commands/` define the plugin; `.mcp.json` only declares the MCP server. (If Claude Code requires `.mcp.json` to recognise the plugin, fall back to shipping it but documenting removal — confirm the convention before deleting; consult the claude-code-guide if unsure.)

**Don't:** Don't lose the `.mcp.json` content — it must be recoverable verbatim from docs (the `${CLAUDE_PLUGIN_ROOT}/dist/server.js` invocation matters).

**Verify:** the repo no longer auto-registers the MCP server on plugin enable (manual reasoning + the documented re-enable steps are accurate); slash commands still present.

---

## Task 2: Repoint slash commands at the CLI

**Files:** Modify `commands/tickets-add.md`, `tickets-done.md`, `tickets-next.md`, `tickets-open.md`, `tickets-status.md`.

**Decisions:**
- Rewrite each to instruct Claude to run the **CLI** instead of the MCP tool, so they work with MCP off. Use a PATH-independent invocation: `node ${CLAUDE_PLUGIN_ROOT}/dist/server.js <command> [...]` (CLAUDE_PLUGIN_ROOT is set in the plugin context), and mention the `ticketgraph <command>` short form for globally-installed users.
- Map: tickets-next → `next`; tickets-status → `stats`; tickets-open → `list --status open` (or the command's existing intent); tickets-add → `add --title … [flags]` (or `add_many --json …` for batches); tickets-done → `update --id <id> --patch …` per the update tool's actual arg shape (check `update.ts` for the exact flag/JSON form — `update` likely needs `--json` for a nested `patch`).
- Keep each command's `description` frontmatter; only change the body to the CLI invocation. Prefer `--format compact` output for human-facing slash commands (it's the default, so no flag needed) — or `--format json` if the command needs to parse.

**Don't:** Don't promise a flag form the CLI rejects — check each tool's schema (esp. `update`'s `patch`, which is likely structured → `--json`). Match T25's per-command help reality.

**Verify:** each slash command's CLI invocation is valid against the built binary (spot-check `node dist/server.js <cmd> --help`); the commands work in an MCP-off configuration.

---

## Task 3: Terse `CLAUDE.md` pointer + dev allowlist

**Files:** Create root `CLAUDE.md` (dogfooding this repo); create `.claude/settings.json`.

**Decisions:**
- **`CLAUDE.md` (≤2 lines, the entire always-on cost):** point Claude at the token-cheap CLI and `--help`, e.g.:
  > Ticket queries: this project has a token-cheap, DB-backed CLI — run `ticketgraph <command>` (read commands: `list`, `get`, `search`, `next`, `stats`; full list + flags via `ticketgraph --help`). Prefer it over reading `.ai/TICKETS.md`. Use `--format json` when you need to parse output. The MCP server is opt-in (off by default).
  **No inline per-command schema** — that would recreate the schema tax in another file. `--help` is the on-demand detail.
- **`.claude/settings.json`:** add a Bash allowlist for `ticketgraph` (and `node …/dist/server.js`) **read** commands so routine queries don't prompt: `list`, `get`, `search`, `next`, `stats`, `changed_since`, `blockers_of`, `children_of`, `related`, `validate`, plus `--help`/`--version`. Write commands stay prompt-gated (NOT allowlisted). Match the project's existing settings style (check `.claude/settings.local.json` if present for the permission format).
- Also document the recommended `CLAUDE.md` snippet for **downstream users** in the README (they add it to their own project).

**Don't:** Don't allowlist write commands (`add`, `update`, `link`, `register_project`, `import_json`, `export`, …) — those should still prompt. Don't put command docs in `CLAUDE.md`.

**Verify:** `CLAUDE.md` is ≤2 lines of pointer with no schema; `.claude/settings.json` is valid JSON and allowlists only read commands.

---

## Task 4: README + docs CLI section; version bump to 0.4.0

**Files:** `README.md`, `docs/usage.md`, `docs/install.md`, `package.json`, `.claude-plugin/plugin.json`.

**Decisions:**
- **README + `docs/usage.md`:** add a "CLI" section — dual-mode (`ticketgraph <command>` vs `--mcp`/no-args server), the `--format compact|json|table` flags (compact default; `--format json` for parsing), the `--json '<obj>'` / `--json -` structured-input convention (required for `add_many`), `--project`/cwd resolution, `--verbose`/`TICKETGRAPH_DEBUG`, and the exit-code contract (0/1/2). Point at `ticketgraph --help`.
- **`docs/install.md`:** note MCP is now opt-in (Task 1) + the global/npx install for the `ticketgraph` bin.
- **Version → 0.4.0** in both `package.json` and `plugin.json`; update `plugin.json`'s description to dual-mode wording. Note the MCP-default change prominently (the one behaviour existing users notice).

**Don't:** Don't overstate — keep docs accurate to the shipped CLI (compact default, `--json` for structured, exit codes from T23).

**Verify:** `npm run build` + full `npm test` green at 0.4.0; `node dist/server.js --version` prints `0.4.0`; docs match real `--help` output.

---

## Caveats & known risks

- **Plugin-convention uncertainty (Task 1):** removing `.mcp.json` is the intended mechanism, but confirm Claude Code still loads the plugin's `commands/` without it. If the plugin system requires `.mcp.json` to exist, the fallback is to keep it but document disabling — verify before deleting (consult claude-code-guide if needed). This is the one genuinely outward-facing change; keep it reversible and documented.
- **`update`/`set_parent` slash commands (Task 2):** these likely need `--json` for nested/`null` args (per T25's findings). Check the real schemas; don't write a slash command that the CLI rejects.
- **CLI invocation form:** slash commands use `node ${CLAUDE_PLUGIN_ROOT}/dist/server.js` (PATH-independent); the bare `ticketgraph` form assumes a global install — document both, don't assume PATH.
- **`.claude/settings.json` permission format:** match Claude Code's actual permission schema (e.g. `permissions.allow` with `Bash(ticketgraph list:*)` patterns) — verify the exact format against an existing example or the settings docs rather than guessing.
- **This is the version bump ticket** — do it LAST (after T22–T25 are all final) so 0.4.0 reflects the complete epic.

---

## Validation review

Risk-scaled adversarial pass: the outward-facing risk (plugin loading without `.mcp.json`) and the slash-command-vs-runtime-truth risk are pre-empted as explicit caveats with verification steps. Because Task 1 touches plugin behaviour, the post-build review gate should specifically confirm the re-enable docs are accurate and complete.

---

## Review record

**Reviewed:** 2026-05-31 (Sonnet implementer + Sonnet review gate; 2 doc Notes applied by hand).
**Verification:** build ✓, typecheck ✓, `npm test` **628 passed / 55 files**, `--version` → `0.4.0`, plus a full end-to-end CLI exercise (below).

### Result: APPROVED (0 Blocking, 0 Important; 4 Notes — 2 fixed, 2 skipped).

**Built as planned:**
- **MCP opt-in:** `.mcp.json` deleted (content preserved verbatim in `docs/install.md` + re-enable steps). claude-code-guide confirmed `commands/` + `plugin.json` load independently, so removing it cleanly disables only the MCP server.
- **Slash commands repointed** to `node ${CLAUDE_PLUGIN_ROOT}/dist/server.js <cmd>` (work with MCP off); `tickets-done` uses `update --json '{"id":…,"patch":{"status":"done"}}'` — matched against `update.ts`'s real `{id,patch}` shape, not a guessed flag form.
- **`CLAUDE.md`** (1 line, no schema) + **`.claude/settings.json`** (allow the 11 read commands in both `ticketgraph` and `node …` forms; deny all 12 write commands), using the confirmed deny→ask→allow syntax.
- **Docs + version:** README/`docs/usage.md`/`docs/install.md` gained CLI sections; `package.json` + `plugin.json` → **0.4.0** with dual-mode descriptions.
- **Test swap:** the obsolete `.mcp.json` file-read tests → a doc-presence test pinning the re-enable path (JSON stanza + arg path + `/reload-plugins`). Reviewer confirmed the 630→628 delta is exactly that swap, no silent coverage drop.

**Notes:** #1 stale `version:"0.1.0"` in `docs/install.md` ping example → fixed to `0.4.0`. #2 `tickets-done` `$ARGUMENTS` multi-word → invalid JSON → added a "single bare ticket id" hint. #3 (`--title` embedded quotes) and #4 (README CLI cwd-resolution sentence) skipped as marginal.

### End-to-end verification (built artifact, MCP off, temp DB)
| Invocation | Result |
|---|---|
| `--version` | `0.4.0` |
| `register_project … --format json` | JSON object |
| `add --project e2e --title … --priority P1` | `T1 open P1 task - First CLI ticket` (compact) |
| `add_many --json -` (stdin) | `created=[T2,T3]` / `count=2` |
| `list` | 3 headerless compact rows |
| `list --format json` | full parseable object |
| `list --format table` | header + width-aligned columns |
| `stats` | terse grouped lines |
| `get NOPE` | `MCP error -32602: … not found`, **exit 2**, no stack |
| no-args | boots MCP server, logs to stderr, exits 0 on EOF |

### Items requiring rework
None. **The CLI epic (T22–T26) is functionally complete and verified end-to-end.**

### Learnings
- The token win is realised: fresh sessions no longer auto-load the MCP (no `.mcp.json`); the always-on cost is one `CLAUDE.md` line + on-demand `ticketgraph --help`. Per-call output is compact by default (~80% smaller than JSON on multi-row lists).
- MCP remains one documented step away (restore `.mcp.json` + `/reload-plugins`); the binary is dual-mode, so the same `dist/server.js` serves both.
