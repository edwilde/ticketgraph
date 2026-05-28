## P1 — Auth + linking

### T44 — `sscloud open` browser shortcuts
**Status:** ✅ Shipped 2026-05-15. New `Command\OpenCommand` registered as `sscloud open <target>`.
**Blockers:** T2.
**Scope:** Browser launcher dispatches per OS family (`open`/`xdg-open`/`cmd /c start ""`).
**Acceptance:**
- `OpenCommandTest` covers each target with a stub launcher.
