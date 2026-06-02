Token-cheap ticket queries via `ticketgraph <command>` (read: list, get, search, next, stats, changed_since, blockers_of, children_of, related, validate, ping; `ticketgraph --help` for all flags). Prefer this over reading `.ai/TICKETS.md`. Use `--format json` to parse output. MCP server is opt-in (see docs/install.md).

## Git workflow

Always commit completed, verified units of work — don't leave changes uncommitted waiting to be asked. Commit after each self-contained piece (a ticket, a fix, a doc update) once `npm run build` + `npm test` are green; keep commits atomic with a descriptive subject. Push when appropriate (after a ticket lands or a logical batch is committed and tests pass). Single-user project: commit directly to `main` (no PR/branch needed unless the work is genuinely exploratory).
