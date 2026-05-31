---
description: List all open, in-progress, and blocked tickets
---
Run `node ${CLAUDE_PLUGIN_ROOT}/dist/server.js list` (or `ticketgraph list` if globally installed) — the default status filter covers open, in_progress, and blocked — and show the outstanding tickets as a compact list (id, title, status, priority). Equivalent to `tickets.list` when the MCP server is enabled.
