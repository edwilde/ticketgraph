---
description: Mark a ticket as done
argument-hint: "[id]"
arguments: [id]
allowed-tools: Bash
---
Run `node ${CLAUDE_PLUGIN_ROOT}/dist/server.js update --json '{"id":"$ARGUMENTS","patch":{"status":"done"}}'` (or `ticketgraph update --json '{"id":"$ARGUMENTS","patch":{"status":"done"}}'` if globally installed). `$ARGUMENTS` must be a single bare ticket id (e.g. `T5`) with no extra words, so the JSON stays valid. Confirm the ticket is closed and that `closed_at` was set. Equivalent to `tickets.update` when the MCP server is enabled.
