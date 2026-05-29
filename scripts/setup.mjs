#!/usr/bin/env node
/**
 * setup.mjs — Register ticketgraph MCP server with the claude CLI.
 *
 * Computes the absolute path to dist/server.js and runs:
 *   claude mcp add --transport stdio -s user ticketgraph -- node <abs>/dist/server.js
 *
 * Degrades gracefully when the claude CLI is not on PATH (prints the manual
 * command and exits 0) or when the server is already registered (exits 0).
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const distServer = resolve(repoRoot, "dist", "server.js");

if (!existsSync(distServer)) {
  console.error("dist/server.js not found. Run `npm run build` first.");
  process.exit(1);
}

const manualCommand = `claude mcp add --transport stdio -s user ticketgraph -- node ${distServer}`;

const result = spawnSync(
  "claude",
  ["mcp", "add", "--transport", "stdio", "-s", "user", "ticketgraph", "--", "node", distServer],
  { stdio: ["ignore", "pipe", "pipe"] }
);

if (result.error) {
  if (result.error.code === "ENOENT") {
    console.log("claude CLI not found on PATH. Run the following command manually:");
    console.log("");
    console.log(`  ${manualCommand}`);
    console.log("");
    process.exit(0);
  }
  console.error(`Unexpected error: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  const stderr = result.stderr?.toString().trim() ?? "";
  console.log(`claude mcp add exited with status ${String(result.status)}.`);
  if (stderr) {
    console.log(stderr);
  }
  console.log("(It may already be registered — run `claude mcp list` to check.)");
  process.exit(0);
}

console.log("ticketgraph MCP server registered successfully.");
console.log("");
console.log("Verify with:");
console.log("  claude mcp list");
console.log("  claude mcp get ticketgraph");
console.log("");
console.log("Then call: tickets.ping");
