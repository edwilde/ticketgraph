---
name: outstanding-tickets
description: Show the project's outstanding (not-done) tickets in a single token-cheap ticketgraph call. Use when the user asks "what's outstanding", "outstanding tickets", "what's still open", or invokes /outstanding-tickets. Does the minimum — one `list` call — and stops.
---

# outstanding-tickets

Show every not-done ticket in **one** `ticketgraph` call, then stop. This skill exists to enforce the minimum: a status question is one `list`, not a pile of follow-up queries.

## Do exactly this

1. Run a single command:
   ```
   ticketgraph list --status outstanding
   ```
   Use the default `compact` format (cheapest for skimming). `--status outstanding` is everything not done — open, in_progress, blocked, and deferred. Add `--project <id>` only if the user names a project; otherwise it resolves from the current directory.

2. Present the returned rows as a short list (id · status · priority · title). That is the whole answer.

## Do NOT

- Do **not** also run `stats`, `blockers_of`, `get`, or a `--version`/install check — those answer different questions the user didn't ask.
- Do **not** read or grep `.ai/TICKETS.md`; the CLI is the source of truth, the markdown is a generated snapshot.
- Only go further — `blockers_of` for a blocked ticket, `get` for full detail — if the user asks an explicit follow-up.

If `ticketgraph` is not on PATH it isn't set up here: report that rather than falling back to reading ticket files.
