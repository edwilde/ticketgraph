---
description: Mark a ticket as done
argument-hint: "[id]"
arguments: [id]
allowed-tools: mcp__ticketgraph__*
---
Use the `tickets.update` MCP tool to set ticket `$ARGUMENTS`'s status to `done` (patch: `{ "status": "done" }`). Confirm the ticket is closed and that `closed_at` was set.
