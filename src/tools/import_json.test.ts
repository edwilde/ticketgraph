import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeImportJsonTool } from "./import_json.js";
import type { ImportFile } from "../lib/import-format.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-import-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = makeTmpDir();
  const { db } = openDb({ path: join(dir, "test.db") });
  const tool = makeImportJsonTool(db);

  db.prepare(
    "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
  ).run("sscloud", "sscloud CLI", dir, "2026-01-01T00:00:00.000Z");

  return { db, tool, dir };
}

function writeImportFile(dir: string, data: ImportFile): string {
  const filePath = join(dir, "import.json");
  writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

const baseFile: ImportFile = {
  project_id: "sscloud",
  tickets: [
    {
      id: "T1",
      title: "First task",
      status: "done",
      created_by: "migrated:sscloud",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "T2",
      title: "Second task",
      status: "open",
      created_by: "migrated:sscloud",
      created_at: "2026-01-02T00:00:00.000Z",
    },
  ],
};

describe("tickets.import_json", () => {
  it("dry_run returns counts and warnings without mutating DB", async () => {
    const { db, tool, dir } = setup();
    const filePath = writeImportFile(dir, baseFile);

    const result = await tool.handle(
      tool.parseArgs({ project: "sscloud", file: filePath, dry_run: true }),
    );

    expect(result.dry_run).toBe(true);
    expect(result.counts.tickets).toBe(2);
    expect(result.counts.relations).toBe(0);
    expect(result.imported).toBeUndefined();

    // DB should be empty.
    const count = (
      db.prepare("SELECT COUNT(*) as n FROM tickets WHERE project_id = ?").get("sscloud") as {
        n: number;
      }
    ).n;
    expect(count).toBe(0);
    db.close();
  });

  it("live import inserts tickets, tags, and relations", async () => {
    const { db, tool, dir } = setup();
    const filePath = writeImportFile(dir, {
      project_id: "sscloud",
      tickets: [
        {
          id: "T1",
          title: "First task",
          created_by: "migrated:sscloud",
          created_at: "2026-01-01T00:00:00.000Z",
          tags: ["alpha", "BETA"],
        },
        {
          id: "T2",
          title: "Second task",
          created_by: "migrated:sscloud",
          created_at: "2026-01-02T00:00:00.000Z",
        },
      ],
      relations: [{ from: "T1", to: "T2", kind: "blocks" }],
    });

    const result = await tool.handle(
      tool.parseArgs({ project: "sscloud", file: filePath }),
    );

    expect(result.imported).toBe(true);
    expect(result.counts.tickets).toBe(2);

    const tickets = db
      .prepare("SELECT id FROM tickets WHERE project_id = ? ORDER BY id")
      .all("sscloud") as Array<{ id: string }>;
    expect(tickets.map((t) => t.id)).toEqual(["T1", "T2"]);

    const relations = db
      .prepare(
        "SELECT from_id, to_id, kind FROM relations WHERE project_id = ? ORDER BY from_id",
      )
      .all("sscloud") as Array<{ from_id: string; to_id: string; kind: string }>;
    expect(relations).toHaveLength(1);
    expect(relations[0]!.from_id).toBe("T1");
    expect(relations[0]!.kind).toBe("blocks");

    // Tags normalised.
    const tags = db
      .prepare("SELECT tag FROM tags WHERE project_id = ? AND ticket_id = ? ORDER BY tag")
      .all("sscloud", "T1") as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(["alpha", "beta"]);
    db.close();
  });

  it("_created audit row is back-dated to ticket created_at", async () => {
    const { db, tool, dir } = setup();
    const filePath = writeImportFile(dir, {
      project_id: "sscloud",
      tickets: [
        {
          id: "T1",
          title: "X",
          created_at: "2025-06-01T10:00:00.000Z",
        },
      ],
    });

    await tool.handle(tool.parseArgs({ project: "sscloud", file: filePath }));

    const audit = db
      .prepare(
        "SELECT changed_at FROM audit_log WHERE project_id = ? AND ticket_id = ? AND field = '_created'",
      )
      .get("sscloud", "T1") as { changed_at: string } | undefined;

    expect(audit).toBeDefined();
    expect(audit!.changed_at).toBe("2025-06-01T10:00:00.000Z");
    db.close();
  });

  it("forward parent reference resolves (child listed before parent in file)", async () => {
    const { db, tool, dir } = setup();
    const filePath = writeImportFile(dir, {
      project_id: "sscloud",
      tickets: [
        { id: "T2", title: "Child", parent_id: "T1" },
        { id: "T1", title: "Parent" },
      ],
    });

    await tool.handle(tool.parseArgs({ project: "sscloud", file: filePath }));

    const child = db
      .prepare("SELECT parent_id FROM tickets WHERE project_id = ? AND id = ?")
      .get("sscloud", "T2") as { parent_id: string | null };
    expect(child.parent_id).toBe("T1");
    db.close();
  });

  it("duplicate without force aborts with McpError", async () => {
    const { db, tool, dir } = setup();
    // Pre-insert T1.
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("T1", "sscloud", "existing", "", "open", "2026-01-01T00:00:00.000Z");

    const filePath = writeImportFile(dir, {
      project_id: "sscloud",
      tickets: [{ id: "T1", title: "Replacement" }],
    });

    await expect(
      tool.handle(tool.parseArgs({ project: "sscloud", file: filePath })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("duplicate with force overwrites cleanly", async () => {
    const { db, tool, dir } = setup();
    // Pre-insert T1.
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("T1", "sscloud", "original title", "", "open", "2026-01-01T00:00:00.000Z");

    const filePath = writeImportFile(dir, {
      project_id: "sscloud",
      tickets: [{ id: "T1", title: "Replacement title" }],
    });

    const result = await tool.handle(
      tool.parseArgs({ project: "sscloud", file: filePath, force: true }),
    );
    expect(result.imported).toBe(true);

    const ticket = db
      .prepare("SELECT title FROM tickets WHERE project_id = ? AND id = ?")
      .get("sscloud", "T1") as { title: string };
    expect(ticket.title).toBe("Replacement title");
    db.close();
  });

  it("dangling relation is skipped with warning, rest imported", async () => {
    const { db, tool, dir } = setup();
    const filePath = writeImportFile(dir, {
      project_id: "sscloud",
      tickets: [{ id: "T1", title: "Only ticket" }],
      relations: [{ from: "T1", to: "T999", kind: "blocks" }],
    });

    const result = await tool.handle(tool.parseArgs({ project: "sscloud", file: filePath }));

    expect(result.imported).toBe(true);
    expect(result.counts.tickets).toBe(1);
    expect(result.warnings.some((w) => w.includes("T999"))).toBe(true);

    const relations = db
      .prepare("SELECT COUNT(*) as n FROM relations WHERE project_id = ?")
      .get("sscloud") as { n: number };
    expect(relations.n).toBe(0);
    db.close();
  });

  it("project mismatch throws McpError", async () => {
    const { db, tool, dir } = setup();
    const filePath = writeImportFile(dir, {
      project_id: "other-project",
      tickets: [],
    });

    await expect(
      tool.handle(tool.parseArgs({ project: "sscloud", file: filePath })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("missing fields default per §5 (status→open, type→task, description→'')", async () => {
    const { db, tool, dir } = setup();
    const filePath = writeImportFile(dir, {
      project_id: "sscloud",
      tickets: [{ id: "T1", title: "Minimal" }],
    });

    await tool.handle(tool.parseArgs({ project: "sscloud", file: filePath }));

    const ticket = db
      .prepare("SELECT status, type, description FROM tickets WHERE project_id = ? AND id = ?")
      .get("sscloud", "T1") as { status: string; type: string; description: string };
    expect(ticket.status).toBe("open");
    expect(ticket.type).toBe("task");
    expect(ticket.description).toBe("");
    db.close();
  });

  it("dry_run with duplicates warns but does not abort", async () => {
    const { db, tool, dir } = setup();
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("T1", "sscloud", "existing", "", "open", "2026-01-01T00:00:00.000Z");

    const filePath = writeImportFile(dir, {
      project_id: "sscloud",
      tickets: [{ id: "T1", title: "Replacement" }],
    });

    const result = await tool.handle(
      tool.parseArgs({ project: "sscloud", file: filePath, dry_run: true }),
    );
    expect(result.dry_run).toBe(true);
    expect(result.warnings.some((w) => w.includes("T1"))).toBe(true);
    db.close();
  });

  it("unregistered project throws McpError", async () => {
    const { db, tool, dir } = setup();
    const filePath = writeImportFile(dir, {
      project_id: "ghost",
      tickets: [],
    });

    await expect(
      tool.handle(tool.parseArgs({ project: "ghost", file: filePath })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("parseArgs throws McpError when project is missing", () => {
    const { db, tool } = setup();
    expect(() => tool.parseArgs({ file: "/tmp/x.json" })).toThrow(McpError);
    db.close();
  });

  it("parseArgs throws McpError when file is missing", () => {
    const { db, tool } = setup();
    expect(() => tool.parseArgs({ project: "sscloud" })).toThrow(McpError);
    db.close();
  });

  it("closed_at is preserved from file when present", async () => {
    const { db, tool, dir } = setup();
    const filePath = writeImportFile(dir, {
      project_id: "sscloud",
      tickets: [
        {
          id: "T1",
          title: "Done ticket",
          status: "done",
          closed_at: "2026-05-27T00:00:00.000Z",
        },
      ],
    });

    await tool.handle(tool.parseArgs({ project: "sscloud", file: filePath }));

    const ticket = db
      .prepare("SELECT closed_at FROM tickets WHERE project_id = ? AND id = ?")
      .get("sscloud", "T1") as { closed_at: string | null };
    expect(ticket.closed_at).toBe("2026-05-27T00:00:00.000Z");
    db.close();
  });
});
