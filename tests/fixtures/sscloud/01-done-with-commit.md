## P0 — Foundation

### T1 — Project scaffold
**Status:** ✅ Done — commit `20d91af` (impl) + `9dac4b6` (tracker). Approved by review with two deferred follow-ups.
**Blockers:** none.
**Scope:**
- `composer.json` — vendor `silverstripeltd/sscloud-cli`, bin `sscloud`.
- `bin/sscloud` shim that boots `Sscloud\App`.
**Acceptance:**
- `composer install` clean.
- `./bin/sscloud version` prints version on macOS + Linux.
