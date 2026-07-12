/**
 * Structural validation tests for slash command files.
 *
 * Checks that the five expected command markdown files exist,
 * each has a non-empty description in frontmatter, each body
 * names its expected MCP tool, and arg-taking commands reference $ARGUMENTS.
 *
 * No live Claude session required — pure file-shape assertions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const COMMANDS_DIR = resolve(ROOT, "commands");

const EXPECTED_COMMANDS = [
  "tickets-add",
  "tickets-status",
  "tickets-next",
  "tickets-open",
  "tickets-done",
  "todo",
] as const;

const EXPECTED_TOOLS: Record<string, string> = {
  "tickets-add": "tickets.add",
  "tickets-status": "tickets.stats",
  "tickets-next": "tickets.next",
  "tickets-open": "tickets.list",
  "tickets-done": "tickets.update",
  todo: "tickets.add",
};

const ARGS_COMMANDS = new Set(["tickets-add", "tickets-done", "todo"]);

function parseFrontmatter(content: string): { description: string } {
  // Split on YAML fence --- (first two occurrences)
  const parts = content.split(/^---\s*$/m);
  // parts[0] = "" (before opening ---), parts[1] = frontmatter, parts[2] = body
  if (parts.length < 3) return { description: "" };
  const fm = parts[1];
  const match = fm.match(/^description:\s*(.+)$/m);
  return { description: match ? match[1].trim() : "" };
}

describe("commands/ directory", () => {
  it("contains every expected command file", () => {
    for (const name of EXPECTED_COMMANDS) {
      const filepath = resolve(COMMANDS_DIR, `${name}.md`);
      expect(existsSync(filepath), `${name}.md should exist`).toBe(true);
    }
  });
});

describe.each(EXPECTED_COMMANDS)("commands/%s.md", (name) => {
  const filepath = resolve(COMMANDS_DIR, `${name}.md`);
  const content = existsSync(filepath) ? readFileSync(filepath, "utf8") : "";

  it("has a non-empty description in frontmatter", () => {
    const { description } = parseFrontmatter(content);
    expect(description.length).toBeGreaterThan(0);
  });

  it(`body names the expected MCP tool (${EXPECTED_TOOLS[name]})`, () => {
    expect(content).toContain(EXPECTED_TOOLS[name]);
  });

  if (ARGS_COMMANDS.has(name)) {
    it("references $ARGUMENTS in the body", () => {
      expect(content).toContain("$ARGUMENTS");
    });
  }
});
