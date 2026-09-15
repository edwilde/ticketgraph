import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { makeProgressTool } from "./progress.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-progress-test-"));
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
  const tool = makeProgressTool(db);

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

describe("tickets.progress", () => {
  it("empty project → tickets 0, points 0, pct 0, basis 'tickets', by_status {}", async () => {
    const { tool } = setup();
    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));

    expect(result.totals.tickets).toBe(0);
    expect(result.totals.points).toBe(0);
    expect(result.totals.pct).toBe(0);
    expect(result.totals.basis).toBe("tickets");
    expect(result.by_status).toEqual({});
  });

  it("mixed seed with deferred excluded → headline and by_status correct", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { status: "open", effort: 3 });
    insertTicket(db, "T2", { status: "open", effort: 5 });
    insertTicket(db, "T3", { status: "in_progress", effort: null });
    insertTicket(db, "T4", { status: "blocked", effort: 2 });
    insertTicket(db, "T5", { status: "done", effort: 2 });
    insertTicket(db, "T6", { status: "done", effort: null });
    insertTicket(db, "T7", { status: "deferred", effort: 8 });

    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));

    expect(result.totals.tickets).toBe(6);
    expect(result.totals.done_tickets).toBe(2);
    expect(result.totals.points).toBe(12);
    expect(result.totals.done_points).toBe(2);
    expect(result.totals.pct).toBe(17);
    expect(result.totals.unsized).toBe(2);
    expect(result.totals.basis).toBe("points");
    expect(result.by_status).toEqual({
      open: 2,
      in_progress: 1,
      blocked: 1,
      done: 2,
    });
    expect(result.by_status).not.toHaveProperty("deferred");
  });

  it("all-unsized seed → pct 50, basis 'tickets'", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { status: "open", effort: null });
    insertTicket(db, "T2", { status: "open", effort: null });
    insertTicket(db, "T3", { status: "done", effort: null });
    insertTicket(db, "T4", { status: "done", effort: null });

    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));

    expect(result.totals.points).toBe(0);
    expect(result.totals.pct).toBe(50);
    expect(result.totals.basis).toBe("tickets");
  });

  it("project: 'all' → aggregates across two projects", async () => {
    const { db, tool } = setup();
    const dir2 = makeTmpDir();
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("proj2", "Project Two", dir2, "2026-01-01T00:00:00.000Z");

    insertTicket(db, "T1", { projectId: "proj1", status: "open", effort: 3 });
    insertTicket(db, "T1", { projectId: "proj2", status: "done", effort: 5 });

    const result = await tool.handle(tool.parseArgs({ project: "all" }));

    expect(result.project).toBe("all");
    expect(result.totals.tickets).toBe(2);
    expect(result.totals.points).toBe(8);
    expect(result.totals.done_points).toBe(5);
  });

  it("byte budget: 20 mixed tickets, JSON.stringify(result) < 400 bytes", async () => {
    const { db, tool } = setup();
    const fib = [1, 2, 3, 5, 8, 13];
    for (let i = 1; i <= 20; i++) {
      insertTicket(db, `T${i}`, {
        status:
          i % 4 === 0
            ? "done"
            : i % 4 === 1
              ? "open"
              : i % 4 === 2
                ? "in_progress"
                : "blocked",
        effort: i % 3 === 0 ? null : fib[i % fib.length],
      });
    }

    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(400);
  });
});
