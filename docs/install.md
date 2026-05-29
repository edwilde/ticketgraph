# Installing ticketgraph

## Prerequisites

- **Node.js ≥ 20** — `node --version` should print `v20.x.x` or higher.
- **Claude CLI** — the `claude` command must be on your PATH. Install from [claude.ai/download](https://claude.ai/download) or via your package manager.
- **Build toolchain for better-sqlite3** — the native SQLite addon compiles on install:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`). This is the most common <5-minute blocker on a fresh machine.
  - **Linux**: `gcc`, `make`, `python3` (usually present; install `build-essential` if not).
  - **Windows**: Visual Studio Build Tools with the "Desktop development with C++" workload.

---

## Quick start (dev install, <5 minutes)

These steps bring you from `git clone` to a working `tickets.ping` call.

1. **Clone the repo**
   ```sh
   git clone https://github.com/edwilde/ticketgraph.git
   cd ticketgraph
   ```

2. **Install dependencies** (compiles better-sqlite3)
   ```sh
   npm install
   ```

3. **Build the server**
   ```sh
   npm run build
   # Produces dist/server.js
   ```

4. **Register the MCP server**
   ```sh
   npm run setup
   # Runs: claude mcp add --transport stdio -s user ticketgraph -- node <abs>/dist/server.js
   # If the claude CLI is not on PATH, it prints the manual command — run it yourself.
   ```

5. **Restart Claude Code** (or run `/reload-plugins` if already open) so the new server is picked up.

6. **Verify**
   ```sh
   claude mcp list
   # ticketgraph should appear
   ```
   Then in a Claude Code session:
   - Run `/mcp` to confirm `ticketgraph` is connected.
   - Call `tickets.ping` — you should receive `{ ok: true, version, db_path, schema_version }`.

---

## Plugin install (dev mode)

When Claude Code loads ticketgraph **as a plugin**, the MCP server declared in `.mcp.json` **auto-starts** — you do not need to run `claude mcp add` or `npm run setup`. Use this route when iterating on the plugin itself.

```sh
claude --plugin-dir /absolute/path/to/ticketgraph
```

After editing `.claude-plugin/plugin.json` or `.mcp.json`, run `/reload-plugins` inside the session to pick up changes without restarting.

> **Note:** Do not double-register. If you used `npm run setup` (direct MCP registration) and also launch with `--plugin-dir`, the server will be registered twice. Use one route at a time.

---

## Direct MCP registration (manual)

If you prefer to register the server without `npm run setup`, run this command directly (substitute your actual repo path):

```sh
claude mcp add --transport stdio -s user ticketgraph -- node /absolute/path/to/ticketgraph/dist/server.js
```

Flags explained:
- `--transport stdio` — use stdio transport (default, but explicit for clarity).
- `-s user` — stores the registration in `~/.claude.json`, making it available in all projects.
- `ticketgraph` — the server name used in `claude mcp list` and `/mcp`.
- `-- node <path>` — the `--` separator is required; everything after it is the command to run.

To update the registered path after moving the repo:
```sh
claude mcp remove ticketgraph
claude mcp add --transport stdio -s user ticketgraph -- node /new/path/dist/server.js
```

---

## Future public install (planned, not yet available)

Once published to npm and the Claude Code marketplace, installation will be:

```sh
# npm (planned)
npm install -g @edwilde/ticketgraph

# Claude Code marketplace (planned)
claude plugin install ticketgraph
```

These routes are not yet available. Use the dev install above.

---

## How project scoping works

ticketgraph automatically resolves the active project from your current workspace. When you call a tool without an explicit `project` argument, the server checks the MCP client's advertised workspace roots (the folders Claude Code has open) and matches them against registered `root_path` values using longest-prefix matching. If no root matches, it falls back to the server process's working directory. Pass `project: "<id>"` to override, or `project: "all"` on read tools to query across all projects.

---

## Verify the installation

```sh
# List registered MCP servers
claude mcp list

# Inspect the ticketgraph entry
claude mcp get ticketgraph
```

Inside a Claude Code session:
- `/mcp` — shows all connected servers; `ticketgraph` should appear as connected.
- Call tool `tickets.ping` — returns `{ ok: true, version: "0.1.0", db_path: "...", schema_version: 1 }`.

---

## Uninstall

```sh
claude mcp remove ticketgraph
```

This removes the registration from `~/.claude.json`. The repo files are unaffected.
