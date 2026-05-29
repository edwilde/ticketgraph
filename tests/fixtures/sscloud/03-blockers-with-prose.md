## P1 — Deploy core

### T8 — Deployment service + Resource
**Blockers:** T2, T3.
**Scope:** `Resource\Deployment` (states, ref types, ids), `Service\DeploymentService` (`trigger`, `get`, `pollState`, `streamLog`). All eleven deploy states encoded as an enum.
**Acceptance:** Unit tests cover terminal-state detection and ref-type validation.

### T3 — Spike: verify deploy log poll endpoint shape
**Status:** ✅ Done — fixtures committed to `tests/Fixtures/live/deploy-log/` covering Deploying (early + mid-infra). Follow-up surfaced: the live ref string lives under `attributes.ref_name`, not `attributes.ref`. Tracked as T60.
**Blockers:** T2 + a real Silverstripe Cloud account/stack with a deployable environment.
**Scope:** Run a real deploy, capture the response of `GET /naut/project/{id}/environment/{id}/deploys/log/{id}`.
**Acceptance:**
- Fixture files for at least one full successful deploy and one failed deploy.
