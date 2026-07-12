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

## Global CLI install

Once the package is published to npm (planned), you can install the `ticketgraph` binary globally:

```sh
npm install -g @edwilde/ticketgraph
# or run without installing:
npx @edwilde/ticketgraph list
```

Until then, use the dev install above and invoke via `node /absolute/path/to/ticketgraph/dist/server.js <command>`, or add `ticketgraph/dist/` to your PATH.

---

## Plugin install (marketplace)

The repo doubles as its own plugin marketplace (`.claude-plugin/marketplace.json`), so the bundled skills install straight from GitHub:

```
/plugin marketplace add edwilde/ticketgraph
/plugin install ticketgraph@ticketgraph
```

`/reload-plugins` (or a fresh session) then surfaces the skills, namespaced under the plugin (e.g. `/ticketgraph:<skill>`).

> **Important:** this installs the **skills only** — the prompt-level wrappers around the CLI. They run `ticketgraph <command>`, so the `ticketgraph` **binary must already be on your PATH** (via the dev install above; `npm install -g @edwilde/ticketgraph` is planned but not yet published). The plugin clone does **not** build the native `better-sqlite3` addon, so a plugin install alone does not give you a working CLI.

---

## Plugin install (dev mode)

When Claude Code loads ticketgraph **as a plugin**, the slash commands and `CLAUDE.md` pointer are active, but the MCP server is **opt-in** (see below). Use this route when iterating on the plugin itself.

```sh
claude --plugin-dir /absolute/path/to/ticketgraph
```

After editing `.claude-plugin/plugin.json`, run `/reload-plugins` inside the session to pick up changes without restarting.

> **Note:** Do not double-register. If you used `npm run setup` (direct MCP registration) and also launch with `--plugin-dir`, the server will be registered twice. Use one route at a time.

---

## Enabling the MCP server (optional)

As of v0.4.0 the MCP server is **opt-in**. The CLI (`ticketgraph <command>` / `node dist/server.js <command>`) works without it and is the default path for slash commands and the `CLAUDE.md` pointer. The MCP server is useful when you want direct tool calls from Claude without running shell commands.

To enable it, restore `.mcp.json` in the plugin root with the following content:

```json
{
  "mcpServers": {
    "ticketgraph": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"]
    }
  }
}
```

Then run `/reload-plugins` (or restart Claude Code). To start the MCP stdio server directly, the preferred form is the `mcp` command; `--mcp` and no-args are equivalent (and are what MCP clients launch over stdio):

```sh
ticketgraph mcp             # preferred — start the MCP stdio server
node dist/server.js mcp     # same, via the built artifact
node dist/server.js --mcp   # equivalent (flag form)
node dist/server.js         # equivalent (no-args also starts MCP)
```

`mcp` is a launch mode, not a CLI command, so it ignores trailing flags — `ticketgraph mcp --help` starts the server rather than printing help.

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

Once published to the Claude Code marketplace, installation will be:

```sh
# Claude Code marketplace (planned)
claude plugin install ticketgraph
```

npm global install is described above. The marketplace route is not yet available.

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
- Call tool `tickets.ping` — returns `{ ok: true, version: "0.13.0", db_path: "...", schema_version: 1 }`.

---

## Uninstall

```sh
claude mcp remove ticketgraph
```

This removes the registration from `~/.claude.json`. The repo files are unaffected.
