import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { makeStatsTool } from "./stats.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-stats-test-"));
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
  const tool = makeStatsTool(db);

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
    effort?: number | null;
  } = {},
) {
  db.prepare(
    `INSERT INTO tickets (id, project_id, title, description, status, priority, type, epic, effort, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.projectId ?? "proj1",
    `Title ${id}`,
    "",
    opts.status ?? "open",
    opts.priority ?? null,
    opts.type ?? "task",
    opts.epic ?? null,
    opts.effort ?? null,
    "2026-01-01T00:00:00.000Z",
  );
}

describe("tickets.stats", () => {
  it("empty project → all groups empty {}, totals 0", async () => {
    const { tool } = setup();
    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));

    expect(result.by_status).toEqual({});
    expect(result.by_priority).toEqual({});
    expect(result.by_epic).toEqual({});
    expect(result.by_type).toEqual({});
    expect(result.by_effort).toEqual({});
    expect(result.totals.tickets).toBe(0);
    expect(result.totals.points).toBe(0);
  });

  it("mixed-status seed → counts correct", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { status: "open", effort: 3 });
    insertTicket(db, "T2", { status: "open", effort: 5 });
    insertTicket(db, "T3", { status: "done", effort: 2 });
    insertTicket(db, "T4", { status: "in_progress", effort: null });

    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));

    expect(result.by_status["open"]).toBe(2);
    expect(result.by_status["done"]).toBe(1);
    expect(result.by_status["in_progress"]).toBe(1);
    expect(result.totals.tickets).toBe(4);
    expect(result.totals.points).toBe(10); // 3 + 5 + 2 + NULL(=0)
  });

  it("project: 'all' → cross-project aggregate", async () => {
    const { db, tool, dir } = setup();
    const dir2 = makeTmpDir();
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("proj2", "Project Two", dir2, "2026-01-01T00:00:00.000Z");

    insertTicket(db, "T1", { projectId: "proj1" });
    insertTicket(db, "T1", { projectId: "proj2" });

    const result = await tool.handle(tool.parseArgs({ project: "all" }));
    expect(result.totals.tickets).toBe(2);
    expect(result.project).toBe("all");
  });

  it("token budget: response < 600 bytes (150 × 4)", async () => {
    const { db, tool } = setup();
    for (let i = 1; i <= 20; i++) {
      insertTicket(db, `T${i}`, {
        status: i % 2 === 0 ? "done" : "open",
        priority: i % 3 === 0 ? "P1" : null,
        type: i % 4 === 0 ? "bug" : "task",
        epic: i % 5 === 0 ? "Auth" : null,
        effort: i % 6 === 0 ? 3 : null,
      });
    }

    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(600);
  });

  it("by_priority 'null' key for tickets with no priority", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { priority: null });

    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));
    expect(result.by_priority["null"]).toBe(1);
  });
});
