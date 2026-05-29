## P1 — Auth + linking

### T4 — `sscloud login` / `logout` / `whoami`
**Blockers:** T1.
**Scope:** `Auth\TokenProvider` interface and `Auth\FileTokenProvider` (writes `~/.config/sscloud/credentials` YAML, `chmod 600`). `Service\Credentials`. Honour `SSCLOUD_EMAIL`/`SSCLOUD_TOKEN` env vars.
**Acceptance:**
- `login` interactive flow (with `--non-interactive` failing fast if creds not on stdin or env).
- File written with `chmod 600`, verified by test.
