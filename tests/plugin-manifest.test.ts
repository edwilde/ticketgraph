/**
 * Plugin manifest validation tests.
 *
 * Validates the shape of .claude-plugin/plugin.json and .mcp.json.
 * Pure JSON-shape tests — no claude CLI calls, safe to run in CI.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const pluginJson = JSON.parse(
  readFileSync(resolve(ROOT, ".claude-plugin/plugin.json"), "utf8")
) as Record<string, unknown>;

const mcpJson = JSON.parse(
  readFileSync(resolve(ROOT, ".mcp.json"), "utf8")
) as Record<string, unknown>;

const packageJson = JSON.parse(
  readFileSync(resolve(ROOT, "package.json"), "utf8")
) as Record<string, unknown>;

describe(".claude-plugin/plugin.json", () => {
  it("is valid JSON with a non-empty name", () => {
    expect(typeof pluginJson["name"]).toBe("string");
    expect((pluginJson["name"] as string).length).toBeGreaterThan(0);
  });

  it('name is "ticketgraph"', () => {
    expect(pluginJson["name"]).toBe("ticketgraph");
  });

  it("has a non-empty description", () => {
    expect(typeof pluginJson["description"]).toBe("string");
    expect((pluginJson["description"] as string).length).toBeGreaterThan(0);
  });

  it("version matches package.json (drift guard)", () => {
    expect(pluginJson["version"]).toBe(packageJson["version"]);
  });
});

describe(".mcp.json", () => {
  it("is valid JSON with a mcpServers.ticketgraph entry", () => {
    const servers = mcpJson["mcpServers"] as Record<string, unknown>;
    expect(servers).toBeDefined();
    expect(servers["ticketgraph"]).toBeDefined();
  });

  it('command is "node"', () => {
    const servers = mcpJson["mcpServers"] as Record<string, unknown>;
    const entry = servers["ticketgraph"] as Record<string, unknown>;
    expect(entry["command"]).toBe("node");
  });

  it('args includes a string containing "${CLAUDE_PLUGIN_ROOT}/dist/server.js"', () => {
    const servers = mcpJson["mcpServers"] as Record<string, unknown>;
    const entry = servers["ticketgraph"] as Record<string, unknown>;
    const args = entry["args"] as string[];
    expect(Array.isArray(args)).toBe(true);
    expect(args.some((a) => a.includes("${CLAUDE_PLUGIN_ROOT}/dist/server.js"))).toBe(true);
  });
});
