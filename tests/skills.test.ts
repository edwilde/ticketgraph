/**
 * Structural validation for skill files.
 *
 * Guards that the `ticket` capture skill exists with correct frontmatter and
 * still carries its defining discipline: log-and-size, do NOT implement. Pure
 * file-shape assertions — no live Claude session required.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function parseFrontmatter(content: string): { name: string; description: string } {
  const parts = content.split(/^---\s*$/m);
  if (parts.length < 3) return { name: "", description: "" };
  const fm = parts[1]!;
  const name = fm.match(/^name:\s*(.+)$/m);
  const description = fm.match(/^description:\s*(.+)$/m);
  return {
    name: name ? name[1]!.trim() : "",
    description: description ? description[1]!.trim() : "",
  };
}

describe("skills/ticket/SKILL.md", () => {
  const filepath = resolve(ROOT, "skills/ticket/SKILL.md");
  const content = existsSync(filepath) ? readFileSync(filepath, "utf8") : "";

  it("exists", () => {
    expect(existsSync(filepath)).toBe(true);
  });

  it("has name 'ticket' and a non-empty description", () => {
    const { name, description } = parseFrontmatter(content);
    expect(name).toBe("ticket");
    expect(description.length).toBeGreaterThan(0);
  });

  it("description triggers on the log-a-ticket phrases", () => {
    const { description } = parseFrontmatter(content);
    for (const phrase of ["new bug", "new ticket", "new task"]) {
      expect(description).toContain(phrase);
    }
  });

  it("carries the capture discipline: size the ticket, do not implement", () => {
    expect(content).toContain("effort");
    expect(content).toMatch(/STOP/);
    expect(content).toMatch(/do not (write|implement)/i);
  });
});
