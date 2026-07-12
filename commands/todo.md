---
description: Capture a new ticket/todo without starting work — investigate, size, and log it
argument-hint: "[description]"
arguments: [description]
allowed-tools: Bash
---
The user is logging work to do later, NOT asking for it now. Follow the `ticket` skill's discipline for "$ARGUMENTS": do a quick read-only investigation, classify it (type/priority), size it with a Fibonacci `--effort`, then create it with `tickets.add` — `ticketgraph add --title "..." --type ... --effort ... --description "..."` (or the MCP `tickets.add` tool). Report the new ticket id and a one-line sizing rationale, then STOP — do not implement it.
