---
name: ticket
description: Log a NEW bug, ticket, or task WITHOUT starting work on it — do a quick read-only investigation, size it with a Fibonacci effort, create it in ticketgraph, then stop. Use when the user says "new bug", "new ticket", "new task", "log a bug/ticket", "raise a ticket", "file a bug", "capture this", or invokes /ticket or /todo. This is a capture step, not a request to implement: it never writes or fixes code.
---

# ticket — capture it, size it, don't build it

"new bug", "new ticket", "new task" (and `/ticket`, `/todo`) mean **record work to do later, not do it now**. File a well-formed, sized ticket and then stop. Starting the implementation is the exact failure this skill exists to prevent — treat the urge to "just quickly fix it" as the signal you're about to get it wrong.

## The one rule

Do not write, edit, or fix code. Investigate only enough to write a useful ticket and size it, create the ticket, report its id, then **STOP**. Implement only if the user asks in a separate, explicit follow-up.

## Steps

1. **Quick investigation — read-only, time-boxed.** Locate the relevant code and confirm the bug is real (or the task is scoped) using codegraph / grep / read. A few minutes, not a deep dive. Do not edit anything.
2. **Classify.** `type` (bug, task, spike, followup, umbrella); `priority` (P0–P3) if the user implies urgency; any tags.
3. **Size it — `effort`.** Assign Fibonacci story points against the rubric: 1 trivial (~15 min), 2 small, 3 a normal day's work (the default when scope is known), 5 meaty (~½ day), 8 big (~full day), 13 split it first. Anchor against tickets already sized, not wall-clock. Leave `effort` unset only when scope is genuinely unbounded (a spike).
4. **Write it.** Title = a crisp one-line summary. Description = what you found: repro steps or trigger, affected files, root-cause hypothesis, and rough acceptance — enough that whoever picks it up (including future-you) can start cold.
5. **Create it.** `ticketgraph add --title "…" --type bug --priority P1 --effort 3 --description "…"` (or the `tickets.add` MCP tool). Quote carefully, or pass structured input via `--json`. If ticketgraph is not set up here (no `ticketgraph` on PATH, or the project isn't registered), append to the project's documented ticket file (e.g. `.ai/TICKETS.md`) instead — same discipline.
6. **Report and STOP.** State the new ticket id, type, effort, and a one-line sizing rationale. Do not begin the work.

## Do NOT

- Start implementing, "just quickly fixing", or refactoring — even when the fix looks trivial. A trivial fix is a 1-point ticket, not a licence to edit.
- Let the investigation turn into the work. Read to size; don't build.
- Skip `effort`. An unsized ticket renders as `-` in `list` / outstanding output; size it now, while the context is fresh.

If the next message is "ok, do it" / "go" / "fix it", pick the ticket up then — and only then.
