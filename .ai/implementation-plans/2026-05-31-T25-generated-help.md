# T25 — Generated `--help` & discoverability — Implementation Plan

> **For the implementer:** Use `subagent-driven-development`. TDD throughout. Builds on T22–T24 (`src/cli/*`, 606 tests green).

**Goal:** Make `--help` the on-demand discovery surface so the always-on `CLAUDE.md` footprint can stay ~1 line (T26). `ticketgraph --help` → registry-derived top-level help **with a global-flags section**; `ticketgraph <command> --help` → per-command help generated from that tool's `inputSchema`. Both rendered from the registry — never a hand-maintained list.
**Architecture:** Enrich `buildHelpText` (top-level) and add `buildCommandHelp(tool)` (per-command) in `src/cli/commands.ts`; reorder `runCli`'s global-flag handling so the command can be identified from a cleaned argv, enabling `<command> --help` routing. No new modules.
**Tech Stack:** TypeScript strict, vitest.

---

## Ticket-scoped context (verified against current code)

- **`commands.ts:buildHelpText(registry)`** already renders the top-level command list (`<name> — <description>`) + the `--mcp` note. It's registry-derived. T25 adds a **global-flags** section.
- **`runCli` ordering today** (`index.ts`): strip `--verbose` → `if argv.includes("--help")` (top-level help, throwaway `:memory:` registry) → `--version` → `extractFormat` (strips `--format` + value) → command resolution. **The `--help` short-circuit runs BEFORE `--format` is stripped**, so the command token can't be reliably identified there yet (`--format json list --help` would see `json` as a positional). T25 must reorder.
- **Per-command help needs the tool's `inputSchema`** (`properties: Record<string,unknown>`, optional `required: string[]`) — available from the same `:memory:` registry the `--help` branch already builds. Property schemas may carry `type`, `enum`, `nullable`, `description`, or `oneOf`/`items` (for arrays). `add_many`'s `tickets`/`relations` are **arrays of objects** — not flag-expressible (must use `--json`).
- **Positional map** lives in `flags.ts` as `PRIMARY_POSITIONAL = {get,related,blockers_of,children_of}` (all → `"id"`). Per-command help should mention the positional for these.
- **`add_many` structured-input** rule is enforced in `input.ts`. Per-command help for any command with an object/array-of-object property must point to `--json`.

---

## Task 1: Reorder `runCli` global-flag handling so `<command> --help` can route

**Files:** Modify `src/cli/index.ts`; extend `src/cli/index.test.ts`.

**Decisions — the new ordering (carefully):**
1. Strip `--verbose`, `setQuiet` (unchanged).
2. **`--version`** anywhere → print version, return 0 (unchanged; terminal, needs no command).
3. **`extractFormat(argv)`** → `{cleanArgv, format, error}` (strips `--format` + its space-form value). **Do NOT exit on a format error yet.**
4. **`--help`** in `cleanArgv` → render help and return 0:
   - Determine the command = the first token in `cleanArgv` that does not start with `-` (i.e. `cleanArgv[0]` unless it's `--help`). Build the `:memory:` registry + catalogue.
   - If that command is a **known** command → `buildCommandHelp(tool)`. Else → `buildHelpText(registry)` (top-level).
   - Using `cleanArgv` (format/verbose already stripped) is why this must follow `extractFormat` — so `--format json list --help` correctly routes to `list`'s help.
5. **Now** apply the format error: if `error` or `format === null` → stderr + exit 2.
6. Command resolution + dispatch (unchanged), using `cleanArgv`.

**Don't:**
- Don't let `--help` win over a genuine format error *silently* in a way that hides bugs — it's fine for `--help` to take precedence (user asked for help), but document it. (`--format bogus list --help` → shows `list` help; `--format bogus list` → exit 2.)
- Don't regress the existing `--help`/`--version`/`--format`/`--verbose` tests — re-run them; adjust only where the routing legitimately changed (e.g. `bogus --help` still → top-level help, exit 0).
- Don't open the real DB for help — keep the `:memory:` throwaway handle (closed in `finally`).

**Verify (test-first):** red tests — `runCli(["list","--help"])` → exit 0, output is per-command (contains `list`'s flags), NOT the full command list; `runCli(["--help"])` → top-level (lists all commands); `runCli(["--format","json","get","--help"])` → `get`'s per-command help (proves routing after format-strip); `runCli(["bogus","--help"])` → top-level help, exit 0; `--version` still wins.

---

## Task 2: Global-flags section in `buildHelpText` (top-level)

**Files:** Modify `src/cli/commands.ts`; extend `src/cli/commands.test.ts`.

**Decisions:**
- After the command list, add a `global flags:` section listing: `--format <compact|json|table>` (default compact; or `TICKETGRAPH_FORMAT`), `--project <id>` (or `all`; else resolved from cwd), `--json <obj>` / `--json -` (structured input; required for `add_many`), `--verbose` (or `TICKETGRAPH_DEBUG`; show info logs), `--version`, `--help`, and the `--mcp`/no-args server note (keep existing).
- Still fully registry-derived for the command list; the global-flags block is static text (these are CLI-global, not per-tool).

**Don't:** Don't hand-list commands — keep iterating the catalogue. Don't duplicate the `--mcp` note.

**Verify (test-first):** `buildHelpText` output contains every catalogue command AND a `global flags:` section naming `--format`/`--project`/`--json`/`--verbose`; adding a tool to a stub registry makes it appear (count commands == catalogue size).

---

## Task 3: `buildCommandHelp(tool)` — per-command help from `inputSchema`

**Files:** Modify `src/cli/commands.ts` (new export `buildCommandHelp`); import `PRIMARY_POSITIONAL` from `flags.ts`; extend `src/cli/commands.test.ts`.

**Decisions:**
- `buildCommandHelp(tool: AnyTool): string`. Header: `usage: ticketgraph <cliName> [--flags]` + the tool's `description`.
- Iterate `inputSchema.properties` (reuse the single-cast `PropSchema`-style introspection from `flags.ts` — type/enum/items/oneOf). For each property render a flag line: `--<name> <type>` + `(required)` if in `required[]` + enum values if present (`one of: a|b|c`) + the property's `description` if present.
- **Flag-expressibility rule (generic, matches the runtime):** a property is flag-expressible if it's `string`/`number`/`boolean`/array-of-scalars. A property that is an **object** or **array-of-objects** (e.g. `add_many.tickets`) is NOT flag-expressible → render it under a `structured input:` note pointing to `--json '<obj>'` / `--json -`. This keeps help honest about how `add_many` is actually driven.
- If the command is in `PRIMARY_POSITIONAL`, add a line: `<id> may be given as a positional (e.g. ticketgraph get T22)`.
- Boolean flags: render as `--<name>` (presence = true), note "(flag)".

**Don't:**
- Don't promise flag forms that the runtime rejects — if `resolveRawArgs`/`parseFlags` can't accept a property as a flag, help must say `--json`. (Cross-check against `input.ts`/`flags.ts` behaviour.)
- Don't crash on a property with no `type` (degrade to a bare `--<name>` line).

**Verify (test-first):** red tests — `buildCommandHelp(list tool)` contains `--status`, `--limit`, `--project`, marks none required, shows the status enum/oneOf sensibly; `buildCommandHelp(add tool)` marks `--title` required; `buildCommandHelp(add_many tool)` shows the `--json` structured-input note (NOT a `--tickets` flag); `buildCommandHelp(get tool)` shows the positional hint. Use the real tools from a `:memory:` registry.

---

## Caveats & known risks

- **Ordering reorder is the main risk** (Task 1). The `--help`-after-`extractFormat` move changes when the command is known. Keep `--version` first (terminal), then format-strip, then `--help` (routes on clean argv), then format-error, then command. Every existing global-flag test must stay green; the only intended behaviour change is that `<command> --help` now yields per-command help instead of top-level.
- **Help must match runtime reality.** The flag-expressibility rule in Task 3 must agree with `input.ts`/`flags.ts` — if help shows `--tickets` for `add_many` but the runtime demands `--json`, that's a discoverability bug worse than no help. The object/array-of-object → `--json` rule is the contract; verify against `add_many`'s schema.
- **`:memory:` registry reuse:** per-command help builds the same throwaway registry as top-level (closed in `finally`). No real DB. Schemas are static so `:memory:` is sufficient.
- **T26 depends on this:** the `CLAUDE.md` pointer will say "run `ticketgraph --help`" — so top-level help must be genuinely self-sufficient for discovery (commands + global flags + how to get per-command detail). Ensure the top-level output tells the reader that `<command> --help` exists.

---

## Validation review

Risk-scaled adversarial pass: the dominant risk (the `runCli` ordering reorder regressing global-flag handling) and the help-vs-runtime-truth risk are pre-empted as explicit decisions/caveats with named tests. Post-build code-review gate (fresh subagent) runs as for T22–T24.

---

## Review record

**Reviewed:** 2026-05-31 (Opus implementer + Sonnet review gate; one fix round).
**Verification:** build ✓, typecheck ✓, `npm test` **630 passed / 55 files** (+24 over T24's 606), confirmed by an independent clean run.

### Result: APPROVED after one fix round. The `runCli` reorder was verified non-regressing (all 8 routing cases pass); 2 Important + 3 Notes fixed; no Blocking.

**Built as planned:**
- `runCli` reordered: `--version` → `extractFormat` (defer error) → `--help` (routes on `cleanArgv`: known command → `buildCommandHelp`, else top-level) → deferred format-error → command. So `--format json get --help` correctly shows `get`'s help, not `json`'s.
- Top-level `buildHelpText`: registry-derived command list + a `global flags:` section (`--format`/`--project`/`--json`/`--verbose`/`--version`/`--help`) + a `<command> --help` hint + the `--mcp` note.
- `buildCommandHelp(tool)`: per-command flags from `inputSchema` with required markers, enum (`one of:`), descriptions; flag-expressibility rule **matching the runtime** (object/array-of-object → `--json` note, no phantom flags); positional hint for the 4 `PRIMARY_POSITIONAL` commands.

**Fix round (review → green):**
| # | Finding | Sev | Fix |
|---|---------|-----|-----|
| 1 | Top-level descriptions not truncated (spec said "truncated"); `add_many`'s multi-line desc made a wall of text | Important | `buildHelpText` truncates each command's description to 79 + `…`; per-command help keeps the full text |
| 2 | `set_parent --parent_id null` footgun — flag passes literal `"null"`, can't deliver JSON null | Important | help-text note `(to clear/set null, use --json)` for `nullable:true` string props (added `nullable` to `PropSchema`); no runtime coercion |
| 3 | typed arrays rendered as bare `array` | Note | `flagType` now renders `string[]`/`number[]` when item type is known (e.g. `--ids string[]`), aiding the repeat-the-flag idiom |
| 4 | `buildHelpText` count test was tautological (`n===n` on a stub) | Note | added a real-registry test asserting `list`/`add`/`ping` appear |
| 5 | `--verbose list --help` routing untested | Note | added test proving `--verbose` strip doesn't promote itself to the command position |

### Items requiring rework
None.

### Learnings
- `--help` is now the self-sufficient discovery surface (commands + global flags + per-command detail on demand) — this is what lets T26 keep the always-on `CLAUDE.md` pointer to one line.
- Per-command help is generated to match runtime flag-expressibility exactly, so it never advertises a flag the CLI rejects (`add_many` → `--json`, nullable strings → `--json` for null).
