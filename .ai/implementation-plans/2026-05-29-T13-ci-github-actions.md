# T13 — CI via GitHub Actions

> **For the implementer:** Use `subagent-driven-development` to implement task-by-task.

**Goal:** A single GitHub Actions workflow that builds and tests on Node 20 across ubuntu + macOS (the macOS run is the `better-sqlite3` native-build canary), cancels superseded runs, and stays under 40 lines — plus a green CI badge in the README.
**Architecture:** One `.github/workflows/ci.yml`, one job with an OS matrix. No coverage/artifact/release jobs.
**Tech Stack:** GitHub Actions YAML; `actions/checkout@v4`, `actions/setup-node@v4`.

---

## Ticket-scoped context

- **The suite must be deterministically green first.** T9/T10/T11/T14 surfaced and fixed several load-sensitive test flakes (spawn-based integration tests: cross-test SIGKILL timer, missing `it` timeouts, tight shutdown/bootstrap bounds, a per-call latency assertion). CI runs on shared 2-core runners — *more* contention than a dev laptop — so any residual flake WILL show up red. Before writing the workflow, confirm the suite is stable (the implementer should run `npm test` a few times locally; the maintainer has already verified 12/12 green). If CI still flakes on the runner, the fix is generous timeouts / reduced vitest parallelism, NOT retries.
- **macOS runner is non-negotiable** (spec §13, §16): it's the canary for the `better-sqlite3` native build breaking on macOS. Do not drop it to save minutes.
- **Workflow shape** (TICKETS.md T13):
  - Triggers: `push` (any branch) + `pull_request`.
  - Matrix: `{ node: ['20.x'], os: [ubuntu-latest, macos-latest] }`. Single job, single matrix.
  - Steps: `actions/checkout@v4` → `actions/setup-node@v4` with `cache: 'npm'` → `npm ci` → `npm run build` → `npm test`.
  - Concurrency: `group: ci-${{ github.ref }}`, `cancel-in-progress: true` (force-pushes don't pile up).
  - No coverage upload, no artifact upload, no release jobs. **Under 40 lines.**
- **`npm ci` requires a committed `package-lock.json`** — it exists (T1). `npm ci` is correct for CI (reproducible, fails on lockfile drift).
- **`npm run build` before `npm test`**: the integration tests spawn `dist/server.js`. The vitest `globalSetup` (T5) ALSO runs `npm run build` — so the explicit build step is partly redundant, but keep it: it surfaces a build failure as its own clear step rather than buried in test globalSetup. (If the redundant double-build is a concern, the test globalSetup is the one that strictly must stay; the explicit step is the readable canary.)
- **better-sqlite3 native build on the runner**: `npm ci` compiles it. On `macos-latest` and `ubuntu-latest` the toolchain is preinstalled. If the macOS job exceeds ~2 minutes or the native build fails (spec §13 risk), pin `better-sqlite3` to the known-good version before merging.
- **actionlint**: the workflow must pass `actionlint` locally (TICKETS.md T13 acceptance). The implementer should run `actionlint .github/workflows/ci.yml` if available (`brew install actionlint`), or at minimum validate YAML structure.
- **Acceptance** (TICKETS.md T13): green run on `main` after this lands + green badge; a deliberately-broken test on a throwaway branch produces a red run with the failing test name visible in the GitHub UI without expanding log groups; macOS job <2 min against the fixture; `actionlint` clean.

---

## Task 1: `.github/workflows/ci.yml`

**Files:**
- Create: `.github/workflows/ci.yml`

**Decisions:**
- Structure (target <40 lines):
  ```yaml
  name: CI
  on:
    push:
    pull_request:
  concurrency:
    group: ci-${{ github.ref }}
    cancel-in-progress: true
  jobs:
    test:
      strategy:
        fail-fast: false
        matrix:
          os: [ubuntu-latest, macos-latest]
          node: ['20.x']
      runs-on: ${{ matrix.os }}
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: ${{ matrix.node }}
            cache: 'npm'
        - run: npm ci
        - run: npm run build
        - run: npm test
  ```
- `fail-fast: false` so an ubuntu failure doesn't cancel the macOS canary (and vice versa) — you want to see both.
- `name: CI` so the badge URL is stable.

**Don't:**
- Don't add coverage/codecov/artifact/release steps (TICKETS.md: keep under 40 lines, no extras).
- Don't drop `macos-latest`.
- Don't add test retries to mask flakes — fix the flake instead.
- Don't add a `workflow_dispatch` or cron unless asked (YAGNI; push+PR is the spec).
- Don't pin to a specific Node patch — `20.x` tracks the LTS line (spec says Node 20 LTS).

**Implement:** Write the workflow.

**Verify:** `actionlint .github/workflows/ci.yml` clean (if installed); YAML parses; line count <40.

---

## Task 2: README CI badge

**Files:**
- Modify: `README.md`

**Decisions:**
- If T12 already added the badge (`![CI](.../actions/workflows/ci.yml/badge.svg)`), confirm the path matches this workflow's filename (`ci.yml`) and `name: CI`. If T12 did NOT add it, add it at the top of the README.
- Badge markdown: `[![CI](https://github.com/edwilde/ticketgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/edwilde/ticketgraph/actions/workflows/ci.yml)`.

**Don't:**
- Don't add a coverage badge (no coverage upload).

**Implement:** Ensure the badge is present and points at `ci.yml`.

**Verify:** Badge markdown references the correct workflow file; renders (will show "no status"/passing once the workflow runs on the default branch).

---

## Task 3: Local verification (pre-push)

**Files:** (none)

**Decisions:**
- CI can only be truly verified once pushed to GitHub. Locally, verify everything the workflow does:
  1. `npm ci` (clean install from lockfile) → exit 0. (Run in a way that doesn't nuke the working `node_modules` if risky — or note that `npm ci` deletes `node_modules` and reinstalls; that's fine.)
  2. `npm run build` → exit 0.
  3. `npm test` → exit 0 (run 2–3× to confirm no flake; the suite was stabilised in prior tickets).
  4. `actionlint` on the workflow if available.

**Implement:** Run the above; record results.

**Verify:** All four pass locally. Note that the GitHub-side acceptance (green run on main, red-on-broken-test visibility, macOS <2 min) is confirmed after push — out of the local scope, but the workflow is structured to satisfy them.

---

## Task 4: Full gate

**Verify:**
1. `npm run build` → exit 0.
2. `npm test` → exit 0; all green.
3. `npm run typecheck` → exit 0.
4. `.github/workflows/ci.yml` exists, <40 lines, `actionlint`-clean (if available).
5. README badge points at `ci.yml`.
6. `grep -rn 'console\.' src/ tests/` → 0 hits.

---

## Caveats & known risks

- **Flakes on CI runners**: shared 2-core runners contend MORE than a dev laptop. The prior tickets' timing fixes (generous spawn-test bounds tied to `it` timeouts, median latency assertion, per-child SIGKILL capture) were specifically to survive this. If CI still flakes, the fix is bigger timeouts or `--no-file-parallelism` / reduced `maxWorkers` in vitest — never test retries.
- **`npm ci` deletes node_modules**: running it locally to verify will reinstall (and recompile better-sqlite3). That's the point of the canary, but it takes a minute. Don't be alarmed by the reinstall.
- **better-sqlite3 macOS build time** (spec §13): if the macOS job blows past ~2 min, pin `better-sqlite3` to the installed known-good version (currently `^11`; pin to the exact resolved version) before merging.
- **Badge shows "no status" until first run**: normal until the workflow runs on the default branch. Not a failure.
- **`push:` with no branch filter** runs on every branch push — intended (TICKETS.md: "push to any branch"). Combined with `cancel-in-progress`, force-pushes don't pile up.
- **Double build** (explicit step + vitest globalSetup): harmless but redundant. Keeping the explicit `npm run build` step makes a build break legible in the CI UI as its own step.

---

## Validation review

(none — standard CI workflow; the only real risk is residual test flakiness on the runner, addressed by the prior stabilisation work and the "no retries" rule.)

---

## Review record

**Reviewed:** 2026-05-29
**Reviewer:** Claude (implementer + structural validation by the lead)
**Branch:** main (unstaged at review time)

### Verification Results
- `.github/workflows/ci.yml` created — **24 lines** (<40).
- 15/15 structural checks pass: `name: CI`; push + pull_request triggers; `concurrency` with `cancel-in-progress: true`; `fail-fast: false`; matrix `os: [ubuntu-latest, macos-latest]`, `node: ['20.x']`; checkout@v4; setup-node@v4 with `cache: 'npm'`; steps `npm ci` → `npm run build` → `npm test`; no coverage/codecov.
- `npm run build` / `npm test` (410/410) / `npm run typecheck` → all exit 0.
- README CI badge already present (T12), points at `ci.yml` with matching `name: CI`.
- `grep -rn 'console\.' src/ tests/` → 0 hits.

### Triage Summary
| # | Finding | Type | Decision |
|---|---------|------|----------|
| 1 | Workflow matches all TICKETS.md T13 requirements (triggers, matrix incl. macOS canary, concurrency, <40 lines, no extras) | Completed as planned | Verified structurally |
| 2 | `actionlint` not installed locally | Deviation (acceptance gap) | Accepted with mitigation — installing it unprompted is an unwarranted system side effect; the YAML was validated structurally (15 checks) and GitHub validates the workflow on first run. If Ed wants the local actionlint gate, `brew install actionlint && actionlint .github/workflows/ci.yml`. |

### Technical Context & Learnings
- **The macOS matrix leg is the `better-sqlite3` native-build canary** (spec §13) — non-negotiable; it catches native-module breakage before Ed hits it.
- **`fail-fast: false`** so an ubuntu failure doesn't cancel the macOS run (you want to see both legs).
- **No test retries** — the suite was deliberately stabilised (generous spawn-test timing bounds tied to `it` timeouts, median latency assertion, per-child SIGKILL capture, temp-DB isolation) specifically so CI on contended 2-core runners stays green without retries.
- **Double build** (explicit `npm run build` step + vitest globalSetup build) is intentional: the explicit step surfaces a build break as its own legible CI step.

### Items Requiring Rework
None.

### Deferred/Skipped Items (verified post-push, not locally)
- Green run on `main` + badge turning green (after push).
- Red-on-broken-test visibility in the GitHub UI; macOS job <2 min (spec §13 — pin better-sqlite3 if it overruns).
- Local `actionlint` run (tool not installed; structural validation substituted).
