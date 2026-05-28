## P2 — Codebase health

### T115 — Extract `OutlierResistantMean` from `EtaEstimator` + `SegmentedEtaEstimator`
**Status:** ✅ Shipped 2026-05-27. Three commits: `b63c1a6` (extraction — new `final class Service\Deploy\OutlierResistantMean`), `a62dc1c` (test-naming honesty follow-up), `42b6a4b` (code-review nit polish). 6 new direct unit tests. 1333/1333 full suite + lint clean.
**Blockers:** none.
**Scope:**
- New `src/Service/Deploy/OutlierResistantMean.php` — final class with `public static function compute(array $durations): float`.
- Both estimators call `OutlierResistantMean::compute(...)`.
**Acceptance:**
- `git grep refinedMean` returns zero hits in `src/`.
- Net delete ≥ 25 LoC.
