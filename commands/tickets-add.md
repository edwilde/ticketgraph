---
description: Create a new ticket with the given title
argument-hint: "[title]"
arguments: [title]
allowed-tools: mcp__ticketgraph__*
---
Use the `tickets.add` MCP tool to create a ticket titled `$ARGUMENTS`. If the user's text implies a priority, type, or effort, pass those too; otherwise just the title. Report the new ticket id.
