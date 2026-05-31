import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { makeToolRegistry } from "../registry.js";
import { NO_ROOTS } from "../lib/roots.js";
import {
  cliNameFor,
  toolNameFor,
  buildCatalogue,
  buildHelpText,
  buildCommandHelp,
} from "./commands.js";
import type { AnyTool } from "../tools/types.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-cli-commands-test-"));
  tmpDirs.push(dir);
  return dir;
}

function buildRegistry() {
  const dir = makeTmpDir();
  const { db, dbPath } = openDb({ path: join(dir, "test.db") });
  return makeToolRegistry({ db, dbPath, getClientRoots: NO_ROOTS });
}

/** Pull a real tool out of a fresh :memory:-style registry by CLI name. */
function tool(cliName: string): AnyTool {
  const t = buildCatalogue(buildRegistry()).get(cliName);
  if (t === undefined) throw new Error(`no such tool: ${cliName}`);
  return t;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cliNameFor / toolNameFor", () => {
  it("strips the tickets. prefix and preserves underscores", () => {
    expect(cliNameFor("tickets.add_many")).toBe("add_many");
    expect(cliNameFor("tickets.register_project")).toBe("register_project");
    expect(cliNameFor("tickets.ping")).toBe("ping");
  });

  it("round-trips cliNameFor → toolNameFor", () => {
    for (const tool of ["tickets.add_many", "tickets.list", "tickets.register_project"]) {
      expect(toolNameFor(cliNameFor(tool))).toBe(tool);
    }
  });
});

describe("buildCatalogue", () => {
  it("maps every registered tool by its CLI name", () => {
    const registry = buildRegistry();
    const catalogue = buildCatalogue(registry);

    expect(catalogue.size).toBe(registry.size);
    expect(catalogue.get("add_many")?.name).toBe("tickets.add_many");
    expect(catalogue.get("list")?.name).toBe("tickets.list");
    expect(catalogue.get("ping")?.name).toBe("tickets.ping");
  });

  it("has no dot-prefixed keys", () => {
    const catalogue = buildCatalogue(buildRegistry());
    for (const key of catalogue.keys()) {
      expect(key.startsWith("tickets.")).toBe(false);
    }
  });
});

describe("buildHelpText — top-level (TASK 2)", () => {
  /** A stub registry of N fake tools so the command count is exact and known. */
  function stubRegistry(n: number): Map<string, AnyTool> {
    const reg = new Map<string, AnyTool>();
    for (let i = 0; i < n; i++) {
      const name = `tickets.cmd${i}`;
      reg.set(name, {
        name,
        description: `desc ${i}`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        parseArgs: (r: unknown) => r,
        handle: async () => ({}),
      } as AnyTool);
    }
    return reg;
  }

  it("lists every catalogue command (count == catalogue size)", () => {
    const reg = stubRegistry(7);
    const out = buildHelpText(reg);
    for (const tool of reg.values()) {
      expect(out).toContain(cliNameFor(tool.name));
    }
    // One command line per catalogue entry.
    const cmdLines = out
      .split("\n")
      .filter((l) => /^\s+cmd\d+ — /.test(l));
    expect(cmdLines).toHaveLength(buildCatalogue(reg).size);
  });

  it("has a global flags: block naming --format/--project/--json/--verbose/--version/--help", () => {
    const out = buildHelpText(stubRegistry(2));
    expect(out).toContain("global flags:");
    expect(out).toContain("--format");
    expect(out).toContain("--project");
    expect(out).toContain("--json");
    expect(out).toContain("--verbose");
    expect(out).toContain("--version");
    expect(out).toContain("--help");
  });

  it("hints that <command> --help gives per-command detail", () => {
    const out = buildHelpText(stubRegistry(2));
    expect(out).toContain("<command> --help");
  });

  it("keeps the existing --mcp / server note", () => {
    const out = buildHelpText(stubRegistry(2));
    expect(out).toContain("--mcp");
  });

  it("real registry: contains list, add, and ping command names", () => {
    const out = buildHelpText(buildRegistry());
    expect(out).toContain("  list —");
    expect(out).toContain("  add —");
    expect(out).toContain("  ping —");
  });

  it("real registry: long descriptions are truncated to ≤80 chars per line", () => {
    const out = buildHelpText(buildRegistry());
    for (const line of out.split("\n")) {
      // Only check command-listing lines (two-space indent + name + em-dash).
      if (/^\s{2}\S+ — /.test(line)) {
        // Extract just the description part after the em-dash.
        const descPart = line.replace(/^\s+\S+ — /, "");
        expect(descPart.length).toBeLessThanOrEqual(80);
      }
    }
  });
});

describe("buildCommandHelp — per-command (TASK 3)", () => {
  it("renders usage + the tool description as a header", () => {
    const out = buildCommandHelp(tool("list"));
    expect(out).toContain("usage: ticketgraph list [--flags]");
    expect(out).toContain("List tickets with optional filters");
  });

  it("list: shows --status, --limit, --project; none marked required", () => {
    const out = buildCommandHelp(tool("list"));
    expect(out).toContain("--status");
    expect(out).toContain("--limit");
    expect(out).toContain("--project");
    expect(out).not.toContain("(required)");
  });

  it("list: --limit reads as a number, --include_description as a flag", () => {
    const out = buildCommandHelp(tool("list"));
    expect(out).toMatch(/--limit\s+number/);
    expect(out).toMatch(/--include_description\s+\(flag\)/);
  });

  it("add: marks --title (required) and surfaces an enum as one of:", () => {
    const out = buildCommandHelp(tool("add"));
    expect(out).toMatch(/--title\b.*\(required\)/);
    // status carries an enum → rendered as a choice list.
    expect(out).toContain("one of: open|in_progress|blocked|done|deferred");
    expect(out).toContain("Ticket title (required).");
  });

  it("add_many: routes to the --json structured-input note, NOT a --tickets flag", () => {
    const out = buildCommandHelp(tool("add_many"));
    expect(out).toContain("structured input:");
    expect(out).toContain("--json");
    // arrays-of-objects are NOT flag-expressible.
    expect(out).not.toContain("--tickets");
    expect(out).not.toContain("--relations");
    // scalar props (project) still render as flags.
    expect(out).toContain("--project");
  });

  it("get: adds the positional hint for a PRIMARY_POSITIONAL command", () => {
    const out = buildCommandHelp(tool("get"));
    expect(out).toContain("ticketgraph get T22");
  });

  it("list: no positional hint (not a PRIMARY_POSITIONAL command)", () => {
    const out = buildCommandHelp(tool("list"));
    expect(out).not.toContain("may be given as a positional");
  });

  it("degrades gracefully: a typeless property renders a bare flag line", () => {
    const fake: AnyTool = {
      name: "tickets.weird",
      description: "weird tool",
      inputSchema: {
        type: "object",
        properties: { mystery: {} },
        additionalProperties: false,
      },
      parseArgs: (r: unknown) => r,
      handle: async () => ({}),
    } as AnyTool;
    const out = buildCommandHelp(fake);
    expect(out).toContain("--mystery");
  });

  it("typed array props render as <itemType>[] (e.g. --tags string[], --ids string[])", () => {
    // get has --ids: array of string; add has --tags: array of string.
    expect(buildCommandHelp(tool("get"))).toMatch(/--ids\s+string\[\]/);
    expect(buildCommandHelp(tool("add"))).toMatch(/--tags\s+string\[\]/);
  });

  it("bare 'array' only when item type is unknown", () => {
    const fake: AnyTool = {
      name: "tickets.weird2",
      description: "weird2",
      inputSchema: {
        type: "object",
        properties: { things: { type: "array" } },
        additionalProperties: false,
      },
      parseArgs: (r: unknown) => r,
      handle: async () => ({}),
    } as AnyTool;
    expect(buildCommandHelp(fake)).toMatch(/--things\s+array/);
  });

  it("nullable string prop renders the --json note (e.g. set_parent --parent_id)", () => {
    const out = buildCommandHelp(tool("set_parent"));
    expect(out).toMatch(/--parent_id\b.*to clear\/set null, use --json/);
  });

  it("non-nullable props do NOT render the --json note", () => {
    // ping has no nullable fields at all.
    const out = buildCommandHelp(tool("ping"));
    expect(out).not.toContain("to clear/set null, use --json");
  });
});
