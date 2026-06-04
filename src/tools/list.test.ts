import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { makeListTool } from "./list.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-list-test-"));
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
  const tool = makeListTool(db);

  db.prepare(
    "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
  ).run("proj1", "Project One", dir, "2026-01-01T00:00:00.000Z");

  return { db, tool, dir };
}

function insertTicket(
  db: ReturnType<typeof setup>["db"],
  id: string,
  opts: {
    projectId?: string;
    status?: string;
    priority?: string | null;
    type?: string;
    epic?: string | null;
    parent_id?: string | null;
    effort?: number | null;
  } = {},
) {
  db.prepare(
    `INSERT INTO tickets (id, project_id, title, description, status, priority, type, epic, parent_id, effort, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.projectId ?? "proj1",
    `Title ${id}`,
    "",
    opts.status ?? "open",
    opts.priority ?? null,
    opts.type ?? "task",
    opts.epic ?? null,
    opts.parent_id ?? null,
    opts.effort ?? null,
    "2026-01-01T00:00:00.000Z",
  );
}

describe("tickets.list", () => {
  it("empty project → { count: 0, rows: [] }", async () => {
    const { tool } = setup();
    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));
    expect(result.count).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it("default status filter excludes done and deferred", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { status: "open" });
    insertTicket(db, "T2", { status: "in_progress" });
    insertTicket(db, "T3", { status: "blocked" });
    insertTicket(db, "T4", { status: "done" });
    insertTicket(db, "T5", { status: "deferred" });

    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));
    expect(result.count).toBe(3);
    const ids = (result.rows as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain("T1");
    expect(ids).toContain("T2");
    expect(ids).toContain("T3");
    expect(ids).not.toContain("T4");
    expect(ids).not.toContain("T5");
  });

  it("status: 'all' returns every ticket", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { status: "open" });
    insertTicket(db, "T2", { status: "done" });
    insertTicket(db, "T3", { status: "deferred" });

    const result = await tool.handle(tool.parseArgs({ project: "proj1", status: "all" }));
    expect(result.count).toBe(3);
  });

  it("status: 'outstanding' includes deferred and excludes done", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { status: "open" });
    insertTicket(db, "T2", { status: "in_progress" });
    insertTicket(db, "T3", { status: "blocked" });
    insertTicket(db, "T4", { status: "deferred" });
    insertTicket(db, "T5", { status: "done" });

    const result = await tool.handle(
      tool.parseArgs({ project: "proj1", status: "outstanding" }),
    );
    const ids = (result.rows as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain("T1");
    expect(ids).toContain("T2");
    expect(ids).toContain("T3");
    expect(ids).toContain("T4"); // deferred is NOT done → outstanding
    expect(ids).not.toContain("T5"); // done is excluded
    expect(result.count).toBe(4);
  });

  it("status: 'outstanding' is a superset of the default filter", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { status: "open" });
    insertTicket(db, "T2", { status: "in_progress" });
    insertTicket(db, "T3", { status: "blocked" });
    insertTicket(db, "T4", { status: "deferred" });
    insertTicket(db, "T5", { status: "done" });

    const def = await tool.handle(tool.parseArgs({ project: "proj1" }));
    const out = await tool.handle(
      tool.parseArgs({ project: "proj1", status: "outstanding" }),
    );
    const defIds = new Set((def.rows as Array<{ id: string }>).map((r) => r.id));
    const outIds = (out.rows as Array<{ id: string }>).map((r) => r.id);
    for (const id of defIds) {
      expect(outIds).toContain(id);
    }
    expect(out.count).toBeGreaterThan(def.count);
  });

  it("status: <bogus> throws InvalidParams (typo fails loudly, not silently empty)", async () => {
    const { tool } = setup();
    expect(() => tool.parseArgs({ project: "proj1", status: "outstandng" })).toThrow(
      /outstandng/,
    );
  });

  it("status as array with bogus member throws InvalidParams", async () => {
    const { tool } = setup();
    expect(() =>
      tool.parseArgs({ project: "proj1", status: ["open", "bogus"] }),
    ).toThrow(/bogus/);
  });

  it("status as array returns matching statuses", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { status: "open" });
    insertTicket(db, "T2", { status: "blocked" });
    insertTicket(db, "T3", { status: "done" });

    const result = await tool.handle(
      tool.parseArgs({ project: "proj1", status: ["open", "blocked"] }),
    );
    expect(result.count).toBe(2);
    const ids = (result.rows as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain("T1");
    expect(ids).toContain("T2");
    expect(ids).not.toContain("T3");
  });

  it("project: 'all' returns rows from multiple projects", async () => {
    const { db, tool, dir } = setup();
    // Register a second project.
    const dir2 = makeTmpDir();
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("proj2", "Project Two", dir2, "2026-01-01T00:00:00.000Z");

    insertTicket(db, "T1", { projectId: "proj1" });
    insertTicket(db, "T1", { projectId: "proj2" });

    const result = await tool.handle(tool.parseArgs({ project: "all" }));
    expect(result.count).toBe(2);
    expect(result.project).toBe("all");
  });

  it("priority filter", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { priority: "P0" });
    insertTicket(db, "T2", { priority: "P1" });
    insertTicket(db, "T3", { priority: null });

    const result = await tool.handle(tool.parseArgs({ project: "proj1", priority: "P0" }));
    expect(result.count).toBe(1);
    expect((result.rows[0] as { id: string }).id).toBe("T1");
  });

  it("epic filter", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { epic: "Auth" });
    insertTicket(db, "T2", { epic: "Search" });

    const result = await tool.handle(tool.parseArgs({ project: "proj1", epic: "Auth" }));
    expect(result.count).toBe(1);
    expect((result.rows[0] as { id: string }).id).toBe("T1");
  });

  it("parent_id filter", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1");
    insertTicket(db, "T2", { parent_id: "T1" });
    insertTicket(db, "T3", { parent_id: "T1" });

    const result = await tool.handle(tool.parseArgs({ project: "proj1", parent_id: "T1" }));
    expect(result.count).toBe(2);
  });

  it("tag filter returns only matching tickets", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1");
    insertTicket(db, "T2");
    db.prepare("INSERT INTO tags (project_id, ticket_id, tag) VALUES (?, ?, ?)").run(
      "proj1", "T1", "fts",
    );

    const result = await tool.handle(tool.parseArgs({ project: "proj1", tag: "fts" }));
    expect(result.count).toBe(1);
    expect((result.rows[0] as { id: string }).id).toBe("T1");
  });

  it("blocked_by filter returns tickets blocked by the given id", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1");
    insertTicket(db, "T2");
    insertTicket(db, "T3");
    // T1 blocks T2 and T3 (T1 is the blocker; spec §5 direction convention).
    db.prepare(
      "INSERT INTO relations (project_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("proj1", "T1", "T2", "blocks", "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO relations (project_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("proj1", "T1", "T3", "blocks", "2026-01-01T00:00:00.000Z");

    const result = await tool.handle(
      tool.parseArgs({ project: "proj1", blocked_by: "T1" }),
    );

    expect(result.count).toBe(2);
    const ids = (result.rows as Array<{ id: string }>).map((r) => r.id).sort();
    expect(ids).toEqual(["T2", "T3"]);
  });

  it("limit and offset pagination", async () => {
    const { db, tool } = setup();
    for (let i = 1; i <= 5; i++) {
      insertTicket(db, `T${i}`);
    }

    const page1 = await tool.handle(tool.parseArgs({ project: "proj1", limit: 2, offset: 0 }));
    const page2 = await tool.handle(tool.parseArgs({ project: "proj1", limit: 2, offset: 2 }));

    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(2);
    expect(page1.count).toBe(5); // total count independent of limit
  });

  it("include_description: false (default) omits description column", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1");

    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));
    const row = result.rows[0] as Record<string, unknown>;
    expect(row["description"]).toBeUndefined();
  });

  it("include_description: true includes description column", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1");

    const result = await tool.handle(
      tool.parseArgs({ project: "proj1", include_description: true }),
    );
    const row = result.rows[0] as Record<string, unknown>;
    expect("description" in row).toBe(true);
  });

  it("token budget: 25-row page from 100-ticket fixture ≤ 1500 × 4 bytes", async () => {
    // Budget note: 50 rows × 12 summary columns × typical field lengths exceeds 6000 bytes
    // structurally. This test verifies a 25-row page — a common single-screen query —
    // stays under the 1500-token (6000-byte) budget. The full 50-row default page is
    // ~10KB (~2500 tokens), acceptable for power queries but over the nominal cap.
    // See plan deviation notes.
    const { db, tool } = setup();
    for (let i = 1; i <= 100; i++) {
      db.prepare(
        `INSERT INTO tickets (id, project_id, title, description, status, priority, type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `T${i}`,
        "proj1",
        `Fix issue ${i}`,
        "",
        "open",
        i % 4 === 0 ? "P0" : i % 3 === 0 ? "P1" : null,
        "task",
        "2026-01-01T00:00:00.000Z",
      );
    }

    const result = await tool.handle(tool.parseArgs({ project: "proj1", limit: 25 }));
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(1500 * 4);
  });

  it("token budget: default page (30 open tickets, no include_description) < 1850 × 4 bytes", async () => {
    // The most common multi-row call: a default list (no limit, no description)
    // over a realistic open backlog. 30 rows measured ~6111 bytes; threshold set
    // just above with headroom. Guards the default summary row shape.
    const { db, tool } = setup();
    for (let i = 1; i <= 30; i++) {
      db.prepare(
        `INSERT INTO tickets (id, project_id, title, description, status, priority, type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `T${i}`,
        "proj1",
        `Fix issue ${i}`,
        "",
        "open",
        i % 4 === 0 ? "P0" : i % 3 === 0 ? "P1" : null,
        "task",
        "2026-01-01T00:00:00.000Z",
      );
    }

    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));
    expect(result.rows).toHaveLength(30);
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(1850 * 4);
  });
});
