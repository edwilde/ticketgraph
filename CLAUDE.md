This project's own development tickets are tracked in `.ai/TICKETS.md` (hand-maintained markdown) — read that file directly. This repo is **not** registered in the ticketgraph DB, so the `ticketgraph` CLI/MCP won't find these tickets; `ticketgraph` is the *product* this repo builds, not the tracker for its own work. The live status table at the top of `.ai/TICKETS.md` is the source of truth for what's open/done.

## Git workflow

Every piece of development starts on a new branch cut from an up-to-date `main`. Never commit to `main` directly.

Commit completed, verified units of work on that branch as you go: one commit per self-contained piece (a ticket task, a fix, a doc update) once `npm run build` and `npm test` are green, with a present-tense subject describing the end state.

When the work is complete and reviewed, open a **draft** pull request against `main`. The PR description is concise: what changed, how it was verified, anything still needing a decision. Run `/ai-slop-cleaner` over the description before posting it. Do not mark the PR ready and do not merge it; Ed merges via GitHub.

## Releases

A release happens only after Ed has merged the PR on GitHub, and only when Ed asks for it. Once the merge has landed, prompt Ed with the proposed version and a one-line summary and wait for a yes. Never tag or release from a feature branch, from an unmerged state, or before the review-implementation stage of the pipeline has finished.

The release itself, once approved: bump the version on `main` when the change is user-visible, minor (`0.x.0`) for behaviour or feature changes and patch (`0.0.x`) for fixes. Keep `package.json`, `package-lock.json` and `.claude-plugin/plugin.json` in sync (a drift-guard test covers the manifest; `src/version.ts` reads `package.json` at runtime). Update the `tickets.ping` example version in `docs/install.md`. Create an annotated tag `vX.Y.Z`, push it, then `gh release create vX.Y.Z --title "vX.Y.Z: <summary>" --notes "<what changed>"`. The GitHub release triggers the npm publish, so a pushed tag with no release is incomplete and the repo's latest release must always match the published package version.

## Adding a tool

A new `tickets.<name>` tool is not done when it is registered in `src/registry.ts`. Also update: the tool-name list and `toHaveLength` count in `tests/server.tools.test.ts`; the command table and the read-command lists in `README.md` and `docs/usage.md`; the task table in `skills/ticketgraph/SKILL.md`; and, if the output needs per-command rendering, a `cliName` branch in `src/cli/format.ts` placed before `rowsOf`/`isStats`.
