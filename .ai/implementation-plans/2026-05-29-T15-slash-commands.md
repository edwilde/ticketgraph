# T15 — Slash commands bundled with the plugin

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Ship five thin slash commands with the plugin (`/ticketgraph:tickets-add`, `-status`, `-next`, `-open`, `-done`) that wrap existing MCP tools, so the high-frequency loop is fast and discoverable. NO new server code.
**Architecture:** A `commands/` directory at the plugin root holding one markdown file per command (frontmatter + a natural-language instruction to call the corresponding MCP tool). Auto-discovered by Claude Code; namespaced under the plugin name. Plus a structural validation test and docs.
**Tech Stack:** Markdown command files; a vitest structural test; docs. No TypeScript server changes, no schema changes.

---

## Ticket-scoped context (authoritative format, confirmed via Claude Code docs)

- **Location:** plugin slash commands live in a **`commands/` directory at the plugin root** (flat markdown files). (`skills/` is the other option but skills can be *model-invoked* — Claude auto-triggers them — which we do NOT want for explicit user commands. `commands/` files are user-invoked only. Decision: use `commands/`.) No `plugin.json` field needed — the directory is auto-discovered.
- **Command file = markdown with YAML frontmatter:**
  ```markdown
  ---
  description: <shown in the / menu and /help>
  argument-hint: "[title]"          # optional, shown in autocomplete
  arguments: [title]                 # optional, enables $title named substitution
  allowed-tools: mcp__ticketgraph__*  # pre-approve the plugin's MCP tools (verify exact prefix)
  ---
  <natural-language instruction telling Claude to call the MCP tool with the args>
  ```
- **Argument substitution in the body:** `$ARGUMENTS` (all), `$0`/`$1` (positional), or `$name` (requires `arguments:` frontmatter). If `$ARGUMENTS` is absent it's auto-appended.
- **Namespacing:** `commands/tickets-add.md` → surfaces as **`/ticketgraph:tickets-add`** (plugin name prefix; from `.claude-plugin/plugin.json` `name: "ticketgraph"`). Filename = command name.
- **Invoking an MCP tool:** there is NO structured "call tool" syntax — the command body is a natural-language instruction ("Use the `tickets.add` MCP tool to …"). `allowed-tools` pre-approves so Claude doesn't prompt. **Verify the exact MCP tool-permission token**: Claude Code namespaces MCP tools as `mcp__<server>__<tool>`; the server is registered as `ticketgraph` (see `.mcp.json`), so the wildcard `mcp__ticketgraph__*` should pre-approve all ticketgraph tools. If the wildcard form isn't accepted, omit `allowed-tools` (Claude will ask once) rather than ship a wrong token — correctness over zero-prompt.
- **Activation:** auto-discovered on plugin load; `/reload-plugins` picks up changes in dev. No restart needed after install.
- **NO server changes** (ticket acceptance): the `git diff` for T15 must touch only `commands/`, `tests/` (the structural test), and docs. The MCP tools already exist (T5/T7/T8). Commands are pure wrappers.
- **Project scoping flows through T14** — commands never hardcode a project; the MCP tools resolve from the client's workspace roots. Commands just call the tool; scoping is automatic.
- **Testing reality:** slash commands can't be exercised in CI (no live Claude session). T15's automatable verification is a **structural test** (files exist, frontmatter parses, each references a real registered MCP tool name, the command set is exactly the five expected). The behavioural acceptance (`/tickets-add "x"` creates a ticket) is a manual checklist in the docs.

---

## Task 1: the five command files

**Files:**
- Create: `commands/tickets-add.md`
- Create: `commands/tickets-status.md`
- Create: `commands/tickets-next.md`
- Create: `commands/tickets-open.md`
- Create: `commands/tickets-done.md`

**Decisions:**
- Each file: `description` (concise, shows in the menu), `argument-hint` + `arguments` where the command takes input, a permissive `allowed-tools: mcp__ticketgraph__*` (or omit if the token form isn't valid — verify first), and a body instructing the specific MCP tool call. Match each to the real tool signature (cross-check `src/tools/`):
  - **tickets-add** — args `[title]` (free text → title). Body: "Use the `tickets.add` MCP tool to create a ticket titled `$ARGUMENTS`. If the user's text implies a priority/type/effort, pass it; otherwise just the title. Report the new ticket id." (`tickets.add` requires only `title`; everything else optional.)
  - **tickets-status** — no args. Body: "Use the `tickets.stats` MCP tool for the current project and summarise the counts (by status/priority/epic/type) and point totals." (`tickets.stats` takes `{ project? }`; omit → cwd/roots-resolved.)
  - **tickets-next** — no args. Body: "Use the `tickets.next` MCP tool and report the recommended next ticket and the reason (priority, age, no open blockers)." (`tickets.next` takes `{ project?, type? }`.)
  - **tickets-open** — no args. Body: "Use the `tickets.list` MCP tool (default status filter = open/in_progress/blocked) and show the outstanding tickets as a compact list (id, title, status, priority)." (`tickets.list` defaults exclude done/deferred.)
  - **tickets-done** — args `[id]`. Body: "Use the `tickets.update` MCP tool to set ticket `$ARGUMENTS`'s status to `done` (patch: { status: \"done\" }). Confirm the ticket closed and that closed_at was set." (`tickets.update` takes `{ id, patch }`.)
- Keep bodies short and imperative — they're instructions, not prose. Each names the exact MCP tool.
- Do NOT use `project: "all"` in any command (these are current-project actions; `tickets-done`/`add`/`update` don't allow `all` anyway).

**Don't:**
- Don't invent tool params — cross-check each against `src/tools/<tool>.ts`.
- Don't hardcode a project id.
- Don't ship a wrong `allowed-tools` token — if `mcp__ticketgraph__*` isn't valid, omit the field.
- Don't add commands beyond the five (keep the surface tight; more can come later).

**Implement:** Write the five command markdown files.

**Verify:** Task 2 structural test + manual checklist (Task 4).

---

## Task 2: structural validation test

**Files:**
- Create: `tests/commands.test.ts`

**Decisions:**
- Pure file-shape test (no live Claude), reading `commands/*.md` from the repo root:
  - Exactly the five expected files exist: `tickets-add`, `tickets-status`, `tickets-next`, `tickets-open`, `tickets-done`.
  - Each file has YAML frontmatter with a non-empty `description`.
  - Each body names a real MCP tool from the known set (`tickets.add`, `tickets.stats`, `tickets.next`, `tickets.list`, `tickets.update`) — assert the body contains the expected tool name for that command.
  - Commands that take arguments (`tickets-add`, `tickets-done`) reference `$ARGUMENTS` (or `$1`/named) in the body.
- A tiny frontmatter parse (split on the `---` fences; don't pull in a YAML dep — a minimal line scan for `description:` is enough, or use a regex). Keep it dependency-free.

**Don't:**
- Don't shell out to `claude` or try to execute the command.
- Don't add a YAML parsing dependency for a 5-file check — a minimal scan suffices.

**Implement:** The structural test.

**Verify:** `npm test tests/commands.test.ts` → green; fails if a command file is missing, lacks a description, or stops naming its tool (drift guard).

---

## Task 3: docs

**Files:**
- Modify: `docs/usage.md` (add a "Slash commands" subsection)
- Modify: `README.md` (one line under Usage pointing at the slash commands)

**Decisions:**
- `docs/usage.md`: a short table — command → what it does → underlying MCP tool — plus a note that they appear as `/ticketgraph:<name>` and a manual "first use" check (`/reload-plugins` or reinstall, then `/ticketgraph:tickets-status`).
- README: one line under Usage: "Bundled slash commands: `/ticketgraph:tickets-add|status|next|open|done` — see docs/usage.md."

**Don't:**
- Don't duplicate the full command bodies in docs — just the table + the activation note.

**Implement:** The doc additions.

**Verify:** Links/section render; commands listed match the five files.

---

## Task 4: manual acceptance checklist + full gate

**Files:** (none — verification only; checklist captured in docs/usage.md)

**Decisions:**
- The behavioural acceptance needs a live session and is a documented manual checklist (can't run in CI):
  1. `/reload-plugins` (dev) or reinstall → the five commands appear under `/ticketgraph:` in the slash menu with their descriptions.
  2. `/ticketgraph:tickets-add Test ticket` → creates a ticket, reports the id.
  3. `/ticketgraph:tickets-status` → returns the project stats.
  4. `/ticketgraph:tickets-done <id>` → flips it to done, closed_at set.
- Automatable gate (CI-safe):

**Verify:**
1. `npm run build` → exit 0.
2. `npm test` → exit 0; all green incl. the new structural test (run twice — suite is timing-stable; don't touch spawn-test bounds).
3. `npm run typecheck` → exit 0.
4. `node dist/server.js --help` → exit 0.
5. `grep -rn 'console\.' src/ tests/` → 0 hits.
6. `git diff --name-only` touches ONLY `commands/`, `tests/commands.test.ts`, `docs/`, `.ai/` (the plan) — **NO `src/` server changes** (ticket acceptance).

---

## Caveats & known risks

- **`commands/` vs `skills/`**: chose `commands/` (user-invoked, no model auto-trigger). If a future need wants Claude to auto-suggest these, migrate to `skills/` with `disable-model-invocation` tuned — but that's a deliberate change, not now.
- **`allowed-tools` token format**: the MCP tool-permission token (`mcp__ticketgraph__*`) must be verified against the installed Claude Code; if wrong, omit `allowed-tools` (a one-time permission prompt is acceptable) rather than ship an incorrect token that silently fails to pre-approve.
- **Can't CI-test behaviour**: slash commands need a live session. The structural test guards file shape + tool-name drift; behaviour is a manual checklist. This is inherent to slash commands, not a gap to fix.
- **Namespacing**: commands surface as `/ticketgraph:tickets-add` (plugin-prefixed), so no collision with any project-level `/tickets-add`. The `tickets-` infix is slightly redundant with the `ticketgraph:` prefix (`/ticketgraph:tickets-add`); kept for clarity, but `/ticketgraph:add` would also read fine — decision: keep `tickets-` for explicitness and to match the ticket's naming.
- **No server changes**: if the implementer finds themselves editing `src/`, they've gone out of scope — the tools already exist; commands only wrap them.
- **Project scoping**: relies on T14 roots resolution — a command run from a registered project's workspace auto-scopes; from an unregistered cwd, the underlying tool returns the clear "register a project" error (which the command surfaces). Don't try to handle scoping in the command.

---

## Validation review

(none — thin markdown wrappers over existing tools + a structural test; the only unknowns are the manifest/command format, confirmed via Claude Code docs, and the `allowed-tools` token, which has a documented safe fallback.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier subagent, fresh context)
**Branch:** feat/t15-slash-commands

### Verification Results
- `npm run build` → 0. `npm test` → 0; **438/438** across 43 files (+13 structural). `npm run typecheck` → 0. `--help` → 0. `grep console.` → 0.
- `git diff` touches ONLY `commands/`, `tests/commands.test.ts`, `docs/`, `.ai/` — **no `src/` changes** (acceptance met).

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | All 20 criteria (5 commands wrap the correct tools with real params; namespaced; no project hardcode; no project:"all"; non-vacuous structural test; accurate docs) | Completed as planned | Verified |
| 2 | `allowed-tools: mcp__ticketgraph__*` kept on the two write commands (add, done); omitted on the three read commands | Deviation (intentional) | Approved — plan sanctioned omitting it; reads get a one-time permission prompt, writes are pre-approved |

### Technical Context & Learnings
- Plugin slash commands live in `commands/*.md` (flat markdown, user-invoked — chosen over `skills/` which auto-invoke). Auto-discovered; surface as `/ticketgraph:<filename>`. Filename = command name; `description` frontmatter shows in the menu; `$ARGUMENTS`/`$1`/`$name` for args.
- The five commands are pure wrappers over existing MCP tools — `tickets.add` / `stats` / `next` / `list` / `update` — so project scoping flows through T14 roots resolution automatically; no command hardcodes a project.
- Slash commands can't be CI-tested (need a live session); `tests/commands.test.ts` guards file shape + tool-name drift, and `docs/usage.md` carries the manual behavioural checklist.
- **No `src/` changes** is the key scope discipline: the tools already existed; T15 only adds wrappers + a test + docs.

### Items Requiring Rework
None.

### Deferred/Skipped Items
- Migrating to `skills/` (for model-auto-invocation) — deliberate non-goal; revisit only if auto-suggestion is wanted.
