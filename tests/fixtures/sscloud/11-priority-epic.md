## P1 — Auth + linking

### T5 — `.sscloud.yml` schema + loader
**Blockers:** T1.
**Scope:** `Service\ProjectConfig` parses and validates `.sscloud.yml`.
**Acceptance:**
- Loader test covers every documented field plus a malformed-file fixture.

### T6 — `sscloud link`
**Blockers:** T2, T5.
**Scope:** Interactive command: list user's stacks, prompt to pick one, write minimal `.sscloud.yml`.
**Acceptance:**
- Run in an empty dir → produces a valid `.sscloud.yml` that round-trips through the loader.
