/**
 * Plugin manifest validation tests.
 *
 * Validates the shape of .claude-plugin/plugin.json and package.json.
 * Pure JSON-shape tests — no claude CLI calls, safe to run in CI.
 *
 * Note: .mcp.json is intentionally absent from the repo as of v0.4.0 —
 * the MCP server is opt-in. Its exact content is documented in
 * docs/install.md under "Enabling the MCP server (optional)".
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

describe("MCP server opt-in documentation", () => {
  it("docs/install.md documents the .mcp.json content and re-enable steps", () => {
    const installMd = readFileSync(resolve(ROOT, "docs/install.md"), "utf8");
    expect(installMd).toContain("${CLAUDE_PLUGIN_ROOT}/dist/server.js");
    expect(installMd).toContain("mcpServers");
    expect(installMd).toContain("/reload-plugins");
  });
});
