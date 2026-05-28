## P2 — Codebase health

### T112 — `BaseCommand` consolidation: credentials + writeError + Branding header
**Status:** Open. Filed 2026-05-26 from T103 review.
**Severity:** Refactor P1.
**Blockers:** none.
**Scope:**
- Add `BaseCommand::resolveApiClient(InputInterface $i, OutputInterface $o, bool $json): ?ApiClient`.
- Promote the duplicated `writeError(OutputInterface, string, bool $json)` to `protected` on `BaseCommand`.
**Acceptance:**
- `BaseCommand` has the three new helpers.
- Net delete ≥ 250 LoC across the 22 commands.
