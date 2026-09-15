This project's own development tickets are tracked in `.ai/TICKETS.md` (hand-maintained markdown) — read that file directly. This repo is **not** registered in the ticketgraph DB, so the `ticketgraph` CLI/MCP won't find these tickets; `ticketgraph` is the *product* this repo builds, not the tracker for its own work. The live status table at the top of `.ai/TICKETS.md` is the source of truth for what's open/done.

## Git workflow

Always commit completed, verified units of work — don't leave changes uncommitted waiting to be asked. Commit after each self-contained piece (a ticket, a fix, a doc update) once `npm run build` + `npm test` are green; keep commits atomic with a descriptive subject. Push when appropriate (after a ticket lands or a logical batch is committed and tests pass). Single-user project: commit directly to `main` (no PR/branch needed unless the work is genuinely exploratory).

Bump the version when a change is user-visible — minor (`0.x.0`) for behaviour/feature changes, patch (`0.0.x`) for fixes. Keep `package.json` and `.claude-plugin/plugin.json` in sync (a drift-guard test enforces this; `src/version.ts` reads `package.json` at runtime). Update the `tickets.ping` example version in `docs/install.md`. Every version bump MUST end in a published GitHub release, not just a tag: create an annotated tag (`vX.Y.Z`), push it, then `gh release create vX.Y.Z --title "vX.Y.Z — <summary>" --notes "<what changed>"`. A pushed tag with no GitHub release is incomplete — the repo's "latest release" must track the code version.

## Adding a tool

A new `tickets.<name>` tool is not done when it is registered in `src/registry.ts`. Also update: the tool-name list and `toHaveLength` count in `tests/server.tools.test.ts`; the command table and the read-command lists in `README.md` and `docs/usage.md`; the task table in `skills/ticketgraph/SKILL.md`; and, if the output needs per-command rendering, a `cliName` branch in `src/cli/format.ts` placed before `rowsOf`/`isStats`.
