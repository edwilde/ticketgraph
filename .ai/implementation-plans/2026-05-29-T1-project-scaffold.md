# T1 — Project Scaffold Implementation Plan

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** Bootstrap an empty TypeScript ESM project with build/test/lint plumbing so subsequent tickets have a working `npm install`, `npm run build`, and `npm test`.
**Architecture:** Single Node.js package, ESM-only, strict TS, ESBuild via tsup, vitest for tests. No source code beyond a `dist/server.js` stub that responds to `--help`.
**Tech Stack:** TypeScript 5.x, Node ≥20, tsup, vitest, better-sqlite3 (declared only; not wired), @modelcontextprotocol/sdk (declared only; not wired).
**Project context cache:** No canonical project guide files exist yet. Source of truth is `docs/specs/2026-05-28-ticketgraph-design.md`.

---

## Ticket-scoped context

- The package is **ESM only** (`"type": "module"`). All `.ts` files use ESM imports/exports.
- Node target is **≥20 LTS**. Use `engines: { node: ">=20" }` in package.json.
- Bin name is `ticketgraph`; the CLI entry is the built `dist/server.js`.
- This ticket *declares* runtime deps but does not wire them; later tickets import them.
- The repo currently has only `.ai/TICKETS.md`, `docs/specs/...`, `.omc/` (ignored). Everything else is new.
- Top-level layout follows §9 of the spec (mcp-server is folded into the repo root — no nested `mcp-server/` directory; the spec's tree was illustrative).
- Effort sizing scale lives at design spec §15.

---

## Task 1: package.json + dependencies

**Files:**
- Create: `package.json`

**Decisions:**
- `name: "@edwilde/ticketgraph"`, `version: "0.1.0"`, `type: "module"`, `private: false`. *Because* the bin is shipped per §9 (eventually `claude plugin install`).
- `bin: { "ticketgraph": "./dist/server.js" }`. *Because* T11 references `ticketgraph --mcp`.
- `main: "./dist/server.js"`, `exports: { ".": "./dist/server.js" }`. ESM-only.
- `engines: { node: ">=20" }`.
- Scripts: `build` → `tsup`, `dev` → `tsup --watch`, `test` → `vitest run`, `test:watch` → `vitest`, `typecheck` → `tsc --noEmit`. *Because* CI (T13) calls `npm run build && npm test`.
- Dev deps: `typescript@^5`, `tsup@^8`, `vitest@^1`, `@types/node@^20`.
- Runtime deps: `@modelcontextprotocol/sdk@latest`, `better-sqlite3@^11`. *Pinned to a major* — spec §13 calls out the better-sqlite3 native-build risk and CI canary; pin to a major to avoid silent jumps but allow patch fixes.
- No `prepublishOnly` yet — package isn't published in this ticket.

**Don't:**
- Don't add `"types"` pointing at a non-existent .d.ts — tsup will emit declarations later when needed, not in this ticket.
- Don't include a `postinstall` script that builds — local dev should `npm run build` explicitly.

**Implement:** Write `package.json` with the fields above. Run `npm install` to populate `package-lock.json`. Commit both.

**Verify:** `npm install` exits 0 and produces a `node_modules/` directory; `package-lock.json` exists. `npm run typecheck` exits 0 against the empty source tree.

---

## Task 2: tsconfig.json

**Files:**
- Create: `tsconfig.json`

**Decisions:**
- `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`. *Because* Node 20 supports ES2022 natively and NodeNext is the canonical ESM resolution mode.
- `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`. Tight type safety from day one.
- `outDir: "dist"`, `rootDir: "src"`, `declaration: false` (tsup emits the bundle).
- `include: ["src/**/*"]`. Tests use vitest's own TS pipeline.
- `esModuleInterop: true`, `skipLibCheck: true`. Standard for ESM packages.

**Don't:**
- Don't enable `composite` or project references — single-package repo doesn't need them.
- Don't add `paths` aliases — keep imports relative for clarity in a small codebase.

**Implement:** Write `tsconfig.json` with the options above.

**Verify:** `npx tsc --noEmit` exits 0.

---

## Task 3: tsup.config.ts

**Files:**
- Create: `tsup.config.ts`

**Decisions:**
- Entry: `src/server.ts`. Output: `dist/server.js`, ESM, sourcemap on, no minification (debug-friendly).
- Target: `node20`.
- `clean: true` so stale builds don't poison `dist/`.
- `shims: false`, `splitting: false`. Single-file CLI bundle.
- Shebang `#!/usr/bin/env node` prepended via `banner: { js: '#!/usr/bin/env node' }` and `chmod +x` handled in a post-build noop (tsup writes the shebang; npm's bin link handles execution).

**Don't:**
- Don't bundle `better-sqlite3` — it's a native module and must remain external. Set `external: ['better-sqlite3', '@modelcontextprotocol/sdk']`.

**Implement:** Write `tsup.config.ts` exporting the config above.

**Verify:** `npm run build` produces `dist/server.js` starting with `#!/usr/bin/env node`. File is non-empty.

---

## Task 4: vitest.config.ts

**Files:**
- Create: `vitest.config.ts`

**Decisions:**
- `environment: "node"`. Server-side only; no jsdom.
- `include: ["tests/**/*.test.ts", "src/**/*.test.ts"]`. Collocated tests OK.
- `coverage` left at defaults; opt-in via `npm test -- --coverage` per spec §16.
- Pool defaults (forks) are fine; better-sqlite3 in integration tests will use unique temp DBs (per §16) so isolation is per-test.

**Don't:**
- Don't set a global setup file that opens a DB connection — each integration test wants its own `TICKETGRAPH_DB_PATH`.

**Implement:** Write `vitest.config.ts` with `defineConfig({ test: { environment: "node", include: [...] } })`.

**Verify:** `npm test` exits 0 with "no test files found" or "0 passed" — both acceptable for an empty test tree.

---

## Task 5: src/server.ts stub

**Files:**
- Create: `src/server.ts`

**Decisions:**
- This is a **stub** — full MCP wiring is T2. Just enough to satisfy the `--help` acceptance criterion.
- Reads `process.argv`. If `--help` is present, prints a one-paragraph usage line to stdout and exits 0.
- Otherwise, exits 0 silently (the MCP stdio loop arrives in T2, where this becomes the entrypoint).
- Imports `package.json` for the version string via `import { readFileSync } from "node:fs"` + JSON parse — `import ... assert { type: "json" }` is unstable across Node minors, so prefer the explicit read. Resolve path via `import.meta.url` + `fileURLToPath`.

**Don't:**
- Don't add any MCP SDK imports yet. T2 owns that.
- Don't add a `process.exit(0)` after async work — there's no async work to await.

**Implement:** Write `src/server.ts` exporting nothing; runs on import. If `--help` in argv → print usage stub `"ticketgraph — MCP server backing the ticketgraph plugin. See docs/specs/2026-05-28-ticketgraph-design.md."` + version, exit 0.

**Verify:** `npm run build && node dist/server.js --help` prints the usage line and exits 0. `node dist/server.js` (no args) exits 0 silently.

---

## Task 6: Config and ignore files

**Files:**
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `.prettierrc`
- Create: `LICENSE`
- Create: `README.md`

**Decisions:**
- `.gitignore` entries (one per line): `node_modules`, `dist`, `*.db`, `*.db-journal`, `*.db-wal`, `*.db-shm`, `coverage`, `.DS_Store`. WAL/SHM journals from `journal_mode = WAL` (spec §5) must not be committed.
- `.editorconfig`: `root = true`, `[*]` → `indent_style = space`, `indent_size = 2`, `end_of_line = lf`, `charset = utf-8`, `trim_trailing_whitespace = true`, `insert_final_newline = true`.
- `.prettierrc`: minimal — `{ "singleQuote": false, "semi": true, "trailingComma": "all", "printWidth": 100 }`. Matches Ed's default Prettier style; later tickets can revisit.
- `LICENSE`: MIT, copyright "2026 Ed Wilde" per spec §12.
- `README.md` stub: one-paragraph project description + link to the design spec + "MVP in progress — see `.ai/TICKETS.md`".

**Don't:**
- Don't commit a `.prettierignore` until there's something to ignore beyond `dist` (already gitignored).
- Don't add ESLint — Prettier + tsc strict cover formatting and type safety for a small codebase; ESLint can be added if/when needed.

**Implement:** Write each file with the contents above.

**Verify:** `git status` shows the new files untracked; no node_modules or dist in the list.

---

## Task 7: Smoke-run the toolchain

**Files:**
- (none — verification only)

**Decisions:**
- This is the gate that proves T1's four acceptance criteria. If any step fails, the matching earlier task is wrong and must be fixed before T1 closes.

**Implement:** Run the verification commands below in order.

**Verify:**
1. `npm install` → exit 0.
2. `npm run build` → exit 0; `dist/server.js` exists.
3. `npm test` → exit 0 (zero tests pass).
4. `node dist/server.js --help` → prints usage stub, exits 0.

---

## Caveats & known risks

- **better-sqlite3 native build**: declared but not imported in T1. The native compile happens at `npm install`. On a fresh macOS without command-line tools this can fail. If `npm install` complains about missing `node-gyp` or Python, document it in `README.md` install prerequisites rather than working around it.
- **MCP SDK version**: `@modelcontextprotocol/sdk` is moving fast. We pin to `latest` *at install time* (locked via `package-lock.json`); T2 will exercise the actual API and may need to bump.
- **ESM + JSON import**: importing `package.json` for the version string is done via `readFileSync` to avoid the still-unstable JSON import attributes. Don't switch to `with { type: "json" }` until Node 22+ is the floor.
- **`type: "module"` consequence**: `tsup.config.ts` is TypeScript and uses ESM `defineConfig` import; tsup itself handles this. Other config files use `.json` to dodge the ESM dance.

---

## Validation review

(none — straightforward scaffold; no Opus escalation triggered.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (Opus subagent, fresh context)
**Branch:** main (scaffold unstaged at review time)

### Verification Results
- `npm install` → exit 0; `node_modules/` + `package-lock.json` populated; better-sqlite3 native compile OK.
- `npm run build` → exit 0; `dist/server.js` 563 B, shebang `#!/usr/bin/env node`.
- `npm test` → exit 0; "No test files found".
- `npm run typecheck` → exit 0.
- `node dist/server.js --help` → exit 0; prints usage stub.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | `@types/better-sqlite3@^7` added as dev dep | Unplanned addition | Approved — pre-positions types for T3 wiring |
| 2 | MCP SDK pinned to `^1.29.0` rather than `"latest"` literal | Deviation (cosmetic) | Approved — matches the plan's "pinned to a major" intent |
| 3 | `passWithNoTests: true` in vitest.config.ts | Unplanned addition | Approved — required for vitest 1.x to satisfy the Task 7 gate |

### Technical Context & Learnings
- Vitest 1.x defaults to exit 1 on an empty test tree. `passWithNoTests: true` is the canonical workaround until real tests land.
- `npm install <pkg>@latest` writes a caret range into package.json. The wording "@latest" in plan decisions should be treated as install-time tag, not the final manifest entry.
- The MCP SDK installed at 1.29.0; future ticket plans should baseline against that range.

### Items Requiring Rework
None.

### Deferred/Skipped Items
None.
