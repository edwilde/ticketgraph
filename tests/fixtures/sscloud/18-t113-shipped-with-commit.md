## P2 — Codebase health

### T113 — `Resource\Internal\PayloadReader` helper for JSON:API parsers
**Status:** ✅ Shipped 2026-05-27. Five commits: `aefc6b6` (Phase 1 — new `trait PayloadReader`), `07f452b` (Phase 2 — migrated 7 Resource parsers). Net delete −51 LoC across `src/Resource/*`. 1347/1347 tests + 3540 assertions + lint clean.
**Blockers:** none.
**Scope:**
- New `src/Resource/Internal/PayloadReader.php` — trait with static methods. See commit `aefc6b6` for Phase 1.
- Methods: `optionalString`, `optionalInt`, `requireString`, `requireArray`.
**Acceptance:**
- All `Resource\*` parsers route nullable-field reads through the trait.
- Net delete ≥ 50 LoC across `src/Resource/*`.
