---
description: Create a new ticket with the given title
argument-hint: "[title]"
arguments: [title]
allowed-tools: Bash
---
Run `node ${CLAUDE_PLUGIN_ROOT}/dist/server.js add --title "$ARGUMENTS"` (or `ticketgraph add --title "$ARGUMENTS"` if globally installed). If the user's text implies a priority, type, or effort, append the appropriate flags (`--priority P1`, `--type bug`, `--effort 3`, etc.); otherwise just pass `--title`. Report the new ticket id from the output. Equivalent to `tickets.add` when the MCP server is enabled.
