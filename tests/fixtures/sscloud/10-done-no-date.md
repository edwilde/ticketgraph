## P0 — Foundation

### T2 — Naut API client spike
**Status:** ✅ Done.
**Blockers:** T1.
**Scope:** `Service\ApiClient` against `https://silverstripe.cloud/naut`. HTTP Basic auth, `X-Api-Version: 2.0` header.
**Acceptance:**
- Integration tests using captured fixtures.
- `ApiClient::listStacks()` returns typed objects.
