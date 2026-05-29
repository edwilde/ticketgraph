import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeAddTool } from "./add.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-add-test-"));
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
  const tool = makeAddTool(db);

  // Register a project for tests to use.
  db.prepare(
    "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
  ).run("proj1", "Project One", dir, "2026-01-01T00:00:00.000Z");

  return { db, tool, dir };
}

describe("tickets.add", () => {
  it("success on empty project → returns ticket with id T1", async () => {
    const { db, tool } = setup();
    const result = await tool.handle(tool.parseArgs({ project: "proj1", title: "First task" }));

    expect(result.ticket.id).toBe("T1");
    expect(result.ticket.project_id).toBe("proj1");
    expect(result.ticket.title).toBe("First task");
    expect(result.ticket.status).toBe("open");
    expect(result.ticket.type).toBe("task");
    expect(result.ticket.created_by).toBe("claude");
    db.close();
  });

  it("auto-id on populated project (3 existing T<n> tickets) → returns T4", async () => {
    const { db, tool } = setup();
    // Insert 3 tickets directly.
    for (const id of ["T1", "T2", "T3"]) {
      db.prepare(
        `INSERT INTO tickets (id, project_id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, "proj1", "existing", "", "open", "2026-01-01T00:00:00.000Z");
    }

    const result = await tool.handle(tool.parseArgs({ project: "proj1", title: "New task" }));
    expect(result.ticket.id).toBe("T4");
    db.close();
  });

  it("explicit id is honoured", async () => {
    const { db, tool } = setup();
    const result = await tool.handle(
      tool.parseArgs({ project: "proj1", id: "CUSTOM-99", title: "Custom" }),
    );
    expect(result.ticket.id).toBe("CUSTOM-99");
    db.close();
  });

  it("duplicate id throws McpError", async () => {
    const { db, tool } = setup();
    await tool.handle(tool.parseArgs({ project: "proj1", id: "T1", title: "First" }));
    await expect(
      tool.handle(tool.parseArgs({ project: "proj1", id: "T1", title: "Duplicate" })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("missing required title → parseArgs throws McpError", () => {
    const { db, tool } = setup();
    expect(() => tool.parseArgs({ project: "proj1" })).toThrow(McpError);
    db.close();
  });

  it("bad status throws McpError from parseArgs", () => {
    const { db, tool } = setup();
    expect(() =>
      tool.parseArgs({ project: "proj1", title: "X", status: "invalid-status" }),
    ).toThrow(McpError);
    db.close();
  });

  it("bad effort (4) → DB CHECK surfaces as McpError", async () => {
    const { db, tool } = setup();
    await expect(
      tool.handle(tool.parseArgs({ project: "proj1", title: "X", effort: 4 })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("tags are normalised (lowercase, trimmed) on insert", async () => {
    const { db, tool } = setup();
    const result = await tool.handle(
      tool.parseArgs({ project: "proj1", title: "Tagged", tags: ["  FTS  ", "SEARCH", "fts"] }),
    );
    const ticketId = result.ticket.id;
    const tags = db
      .prepare("SELECT tag FROM tags WHERE project_id = ? AND ticket_id = ? ORDER BY tag")
      .all("proj1", ticketId) as Array<{ tag: string }>;
    // "fts" appears twice (from "  FTS  " and "fts") → deduped to 1; plus "search"
    expect(tags.map((t) => t.tag).sort()).toEqual(["fts", "search"]);
    db.close();
  });

  it("multiple-prefix project → error pointing at explicit-id requirement", async () => {
    const { db, tool } = setup();
    // Insert tickets with two equal-count prefixes.
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("BUG-1", "proj1", "bug", "", "open", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("FEAT-1", "proj1", "feat", "", "open", "2026-01-01T00:00:00.000Z");

    await expect(
      tool.handle(tool.parseArgs({ project: "proj1", title: "New" })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("audit log contains exactly one _created row for the inserted ticket", async () => {
    const { db, tool } = setup();
    const result = await tool.handle(tool.parseArgs({ project: "proj1", title: "Audited" }));
    const ticketId = result.ticket.id;

    const auditRows = db
      .prepare(
        "SELECT * FROM audit_log WHERE project_id = ? AND ticket_id = ? AND field = '_created'",
      )
      .all("proj1", ticketId) as Array<Record<string, unknown>>;

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!["old_value"]).toBeNull();
    expect(auditRows[0]!["new_value"]).toBe(ticketId);
    // audit changed_at should equal ticket created_at
    expect(auditRows[0]!["changed_at"]).toBe(result.ticket.created_at);
    db.close();
  });

  it("created_by defaults to 'claude' when omitted", async () => {
    const { db, tool } = setup();
    const result = await tool.handle(tool.parseArgs({ project: "proj1", title: "X" }));
    expect(result.ticket.created_by).toBe("claude");
    db.close();
  });

  it("created_by is honoured when supplied", async () => {
    const { db, tool } = setup();
    const result = await tool.handle(
      tool.parseArgs({ project: "proj1", title: "X", created_by: "ed" }),
    );
    expect(result.ticket.created_by).toBe("ed");
    db.close();
  });

  it("priority, effort, epic, type are stored correctly", async () => {
    const { db, tool } = setup();
    const result = await tool.handle(
      tool.parseArgs({
        project: "proj1",
        title: "Full ticket",
        priority: "P1",
        effort: 3,
        epic: "Foundation",
        type: "bug",
      }),
    );
    expect(result.ticket.priority).toBe("P1");
    expect(result.ticket.effort).toBe(3);
    expect(result.ticket.epic).toBe("Foundation");
    expect(result.ticket.type).toBe("bug");
    db.close();
  });
});
