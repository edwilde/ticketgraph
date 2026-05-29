# T12 — README and usage docs

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Replace the README stub with a real README (problem, install, usage, tool reference, differentiation) and add `docs/usage.md` (example prompts → the MCP calls Claude makes) + a migration guide, so a non-Ed reader can install and use ticketgraph.
**Architecture:** Docs only — no code. README links out to `docs/install.md` (T11) and `docs/import-format.md` (T9) rather than duplicating them. A new `docs/usage.md` carries the example-prompt narrative.
**Tech Stack:** Markdown.

---

## Ticket-scoped context

- **Current state of docs**: `README.md` is a one-paragraph stub (T1). `docs/install.md` exists (T11, full install guide). `docs/import-format.md` exists (T9, JSON intermediate schema). `docs/specs/2026-05-28-ticketgraph-design.md` is the design of record.
- **Don't duplicate install**: README's install section is a short pointer + the 4-command quick start, then "see `docs/install.md` for prerequisites, plugin mode, and troubleshooting." Install detail lives in one place.
- **Tool surface to summarise** (the README "tool reference" table): the 21 registered tools — ping, register_project, add, list, get, search, next, related, blockers_of, children_of, changed_since, stats, validate, update, link, unlink, set_parent, append_to_description, add_tag, remove_tag, import_json. Group them (read / write / convenience / admin / migration) with one-line descriptions. Keep it a scannable table, not exhaustive param docs (the design spec §6 has the detail; link to it).
- **Differentiation vs storybloq** (spec §12): the README must answer "why is this different from storybloq?" — token efficiency as the USP (every common query <2k tokens), MIT licence, typed directional relations, tight single-user scope, no team surfaces.
- **Project scoping** (post-T14): explain that ticketgraph auto-scopes to the project whose registered `root_path` contains your current workspace (resolved via MCP roots), with `project: "<id>"` override and `project: "all"` for cross-project reads. This is a key concept for users — give it a short section.
- **Example prompts → MCP calls** (`docs/usage.md`): the acceptance criterion names three — "show me my open P0s", "what's blocking T7?", "find tickets about FTS". For each, show the natural-language prompt and the actual tool call Claude makes. Add a few more covering add/complete/stats/next.
- **Migration guide**: for users coming from a flat `TICKETS.md` — point at the parsers (demo/sample as worked examples), the `import_json` dry-run → eyeball → live flow (spec §7), and `docs/import-format.md` for the JSON schema. Note that ticketgraph does NOT regenerate TICKETS.md (spec §2: the MCP becomes canonical; the markdown is migrated once then deleted).
- **CI badge**: the README gets a CI badge once T13 lands. T12 adds a placeholder/commented badge line OR T13 adds it. **Decision:** T12 adds the badge markdown pointing at the expected workflow URL; if the workflow doesn't exist yet it renders as "unknown" until T13 — acceptable, and avoids a second README edit. Note the dependency.
- **Acceptance** (TICKETS.md T12): README answers what-it-is / why-different-from-storybloq / how-to-install / three example queries; a non-Ed reader could follow it to a working install.

---

## Task 1: README.md rewrite

**Files:**
- Modify: `README.md`

**Decisions:**
- Sections, in order:
  1. **Title + one-liner + CI badge** — "ticketgraph — token-efficient ticket tracking for Claude, backed by SQLite + FTS5." Badge: `![CI](https://github.com/edwilde/ticketgraph/actions/workflows/ci.yml/badge.svg)`.
  2. **Problem** — dense `.ai/TICKETS.md` files cost a full-file read per query (spec §1); ticketgraph makes every common query cost hundreds of tokens, not tens of thousands.
  3. **What it is** — a Claude Code plugin exposing ~21 MCP tools over one global SQLite DB at `~/.claude/tickets.db`. Single-user, single-machine.
  4. **Why it's different from storybloq** (spec §12) — the 5 bullets: token efficiency USP, MIT licence, typed directional relations, tight scope, no team surfaces.
  5. **Install** — the 4-command quick start (`git clone` → `npm install` → `npm run build` → `npm run setup`), then "→ full guide: [docs/install.md](docs/install.md)".
  6. **Project scoping** — short: auto-scope from workspace (MCP roots), `project` override, `project: "all"`.
  7. **Usage** — 3 example prompts inline (the acceptance trio) + "→ more: [docs/usage.md](docs/usage.md)".
  8. **Tool reference** — grouped table (read / write / convenience / admin / migration), one line each, link to design spec §6 for full params.
  9. **Migration** — one paragraph + link to the migration section / `docs/import-format.md`.
  10. **Development** — `npm test`, `npm run build`, `npm run typecheck`; link to the design spec.
  11. **Licence** — MIT.

**Don't:**
- Don't duplicate `docs/install.md` content — link it.
- Don't document every tool's params — summarise + link spec §6.
- Don't claim the npm/marketplace public install works (planned).

**Implement:** Rewrite README per the outline.

**Verify:** README answers the four acceptance questions (what / why-different / install / 3 queries). A skim confirms the links resolve to existing files.

---

## Task 2: docs/usage.md

**Files:**
- Create: `docs/usage.md`

**Decisions:**
- For each example: **Prompt** (what the user types to Claude) → **Call** (the tool + args Claude invokes) → **Why** (one line).
- Cover at least:
  - "show me my open P0s" → `tickets.list({ priority: "P0" })` (default status filter already excludes done).
  - "what's blocking T7?" → `tickets.blockers_of({ id: "T7" })`.
  - "find tickets about FTS" → `tickets.search({ q: "FTS" })`.
  - "add a ticket: tighten the ranking" → `tickets.add({ title: "Tighten the ranking" })`.
  - "mark T5 done" → `tickets.update({ id: "T5", patch: { status: "done" } })`.
  - "what should I work on next?" → `tickets.next({})`.
  - "what changed today?" → `tickets.changed_since({ since: "<today>" })`.
  - "project summary" → `tickets.stats({})`.
  - "across all my projects, what P0s are open?" → `tickets.list({ project: "all", priority: "P0" })`.
- Add a short intro on project scoping (mirrors README, points to the design spec for the resolution algorithm).

**Don't:**
- Don't invent tools or params that don't exist — every call must match a real tool's actual signature (cross-check against `src/tools/`).

**Implement:** Write `docs/usage.md`.

**Verify:** Every tool call in the doc corresponds to a registered tool with matching arg names (spot-check against `src/tools/*.ts`).

---

## Task 3: Migration guide

**Files:**
- Create: `docs/migration.md` (or a section in `docs/usage.md` — prefer a dedicated file).

**Decisions:**
- Audience: someone with a flat `.ai/TICKETS.md` who wants it in ticketgraph.
- Content:
  1. The model: the MCP becomes canonical; TICKETS.md is migrated once then deleted (spec §2). No regeneration.
  2. The flow (spec §7): register the project → run the parser (demo/sample as built-in examples, or write a small parser to the JSON intermediate) → `import_json({ dry_run: true })` → eyeball counts/warnings → `import_json({ dry_run: false })` → delete the old TICKETS.md.
  3. Link to `docs/import-format.md` for the JSON intermediate schema.
  4. Note: parsers for demo/sample ship in `dist/parsers/`; other formats need a small parser to the same JSON shape.

**Don't:**
- Don't promise auto-detection of arbitrary formats — the JSON intermediate is the contract; per-format parsers are bespoke.

**Implement:** Write `docs/migration.md`; link it from README's Migration section.

**Verify:** The flow matches `import_json`'s actual behaviour (dry_run, warnings, force) from T9.

---

## Task 4: Full gate

**Files:** (none — docs only)

**Decisions:**
- No code changed, so build/test/typecheck should be unaffected — run them anyway to confirm nothing regressed (e.g. a stray fenced code block isn't executed, README isn't imported).

**Verify:**
1. `npm test` → exit 0 (unchanged; docs don't affect tests).
2. `npm run build` / `npm run typecheck` → exit 0.
3. All intra-repo links in README resolve to existing files (`docs/install.md`, `docs/usage.md`, `docs/migration.md`, `docs/import-format.md`, `docs/specs/...`).
4. `grep -rn 'console\.' src/ tests/` → 0 hits (unchanged).

---

## Caveats & known risks

- **CI badge before CI exists**: the badge renders "unknown"/broken until T13's workflow lands and runs green. Acceptable; avoids a second README edit. If preferred, T13 adds the badge instead — but T12 adding it keeps the README complete now.
- **Tool list drift**: the README tool table lists 21 tools as of T14. If tools are added later, the table must be updated — note this near the table so it isn't forgotten.
- **Usage examples must match real signatures**: the biggest doc risk is documenting a call that doesn't match the tool. Cross-check each against `src/tools/` during implementation, not from memory.
- **`project: "all"` only on reads**: usage examples using `project: "all"` must only do so on list/search/stats (not add/update/get) — match the `allowAll` reality.

---

## Validation review

(none — docs-only ticket; the only risk is accuracy, mitigated by cross-checking calls against `src/tools/`.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (verifier subagent, fresh context — cross-checked every documented call against `src/tools/`)
**Branch:** main (unstaged at review time)

### Verification Results
- `npm test` → exit 0; 410/410 (docs don't affect tests).
- `npm run build` / `npm run typecheck` → exit 0.
- `grep -rn 'console\.' src/ tests/` → 0 hits.
- All 9 intra-repo links resolve to existing files.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | All 10 acceptance criteria (what / why-different / install / 3 queries / scoping / badge / 21-tool table / usage 9 prompts / migration flow / no install-dup) | Completed as planned | Verified |
| 2 | Every documented tool call (17 in README+usage) matches a real signature; `project: "all"` only on list/search/stats | Completed as planned | Independently cross-checked against `src/tools/` |
| 3 | "240-char snippet" wording is approximate (impl uses 16 FTS5 tokens) | Nit | Deferred — matches the tool's own `inputSchema` description; correcting it would update both together |

### Technical Context & Learnings
- **Docs structure**: `README.md` (overview + links), `docs/install.md` (T11), `docs/usage.md` (prompt→call examples), `docs/migration.md` (TICKETS.md → store), `docs/import-format.md` (T9, JSON intermediate), `docs/specs/...` (design of record). README links out rather than duplicating.
- **Doc-accuracy discipline**: every example call was cross-checked against the actual tool `parseArgs`/schema — not written from memory. `project: "all"` is shown only on the three `allowAll` read tools. This is the main risk for a docs ticket and was verified twice (implementer + independent reviewer).
- The CI badge (added here) points at `ci.yml`; the workflow lands in T13.

### Items Requiring Rework
None.

### Deferred/Skipped Items
- "240-char" snippet wording (approximate; matches tool self-description).
- Tool table must be updated if tools are added/removed (noted in the README near the table).
