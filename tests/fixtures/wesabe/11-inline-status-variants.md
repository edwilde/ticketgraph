# Wesabe — Silverstripe CMS Recreation

---

## Epic 99: Status Variant Showcase

### TEST-01: Open ticket (no status suffix)

> An open ticket with no inline status marker at all.

- Some bullet point work
- **AC:** Parses as open

### TEST-02: Deferred ticket — DEFERRED

> A ticket that has been deferred.

- No current work planned
- **AC:** Parses as deferred

### TEST-03: In progress ticket — IN PROGRESS

> A ticket currently being worked on.

- Work is underway
- **AC:** Parses as in_progress
- **Blocked by:** TEST-01

### TEST-04: Blocked ticket — BLOCKED

> A ticket blocked by dependencies.

- Waiting on external dependency
- **AC:** Parses as blocked
- **Blocked by:** TEST-02, TEST-03
