import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { makeProgressTool } from "./progress.js";
import { buildCommandHelp } from "../cli/commands.js";

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

  it("by: 'bogus' → McpError naming the four allowed values", async () => {
    const { tool } = setup();
    expect(() => tool.parseArgs({ project: "proj1", by: "bogus" })).toThrow(
      /epic.*parent.*type.*tag/s,
    );
  });

  it("by: 'epic' → groups sorted by pct with '(none)' present", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { epic: "core", status: "done", effort: 1 });
    insertTicket(db, "T2", { epic: "infra", status: "open", effort: 1 });
    insertTicket(db, "T3", { epic: "infra", status: "open", effort: 1 });
    insertTicket(db, "T4", { epic: null, status: "open", effort: 1 });

    const result = await tool.handle(tool.parseArgs({ project: "proj1", by: "epic" }));

    expect(result.groups).toBeDefined();
    const keys = result.groups!.map((g) => g.key);
    expect(keys).toContain("(none)");
    expect(keys).toContain("core");
    expect(keys).toContain("infra");
    expect(keys).toHaveLength(3);

    const pcts = result.groups!.map((g) => g.pct);
    expect(pcts).toEqual([...pcts].sort((a, b) => a - b));

    const core = result.groups!.find((g) => g.key === "core")!;
    expect(core.tickets).toBe(1);
    expect(core.done_tickets).toBe(1);
    expect(core.pct).toBe(100);

    const infra = result.groups!.find((g) => g.key === "infra")!;
    expect(infra.tickets).toBe(2);
    expect(infra.done_tickets).toBe(0);
    expect(infra.pct).toBe(0);
  });

  it("no 'by' → groups absent", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { epic: "core", status: "done", effort: 1 });

    const result = await tool.handle(tool.parseArgs({ project: "proj1" }));

    expect(result.groups).toBeUndefined();
  });

  it("by: 'parent' → parent_id used, '(none)' for roots", async () => {
    const { db, tool } = setup();
    insertTicket(db, "P1", { status: "open", effort: 1 });
    db.prepare(
      "INSERT INTO tickets (id, project_id, title, description, status, priority, type, epic, parent_id, effort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("C1", "proj1", "Child", "", "done", null, "task", null, "P1", 1, "2026-01-01T00:00:00.000Z");

    const result = await tool.handle(tool.parseArgs({ project: "proj1", by: "parent" }));

    const keys = result.groups!.map((g) => g.key).sort();
    expect(keys).toEqual(["(none)", "P1"]);
  });

  it("by: 'type' → no '(none)' row (type is NOT NULL)", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { type: "bug", status: "open", effort: 1 });
    insertTicket(db, "T2", { type: "task", status: "done", effort: 1 });

    const result = await tool.handle(tool.parseArgs({ project: "proj1", by: "type" }));

    const keys = result.groups!.map((g) => g.key);
    expect(keys).not.toContain("(none)");
    expect(keys.sort()).toEqual(["bug", "task"]);
  });

  it("all-unsized group sorts by its ticket-based pct: a (0%), c (33%), b (50%)", async () => {
    const { db, tool } = setup();
    // epic a: 2 open, 0 points -> 0%
    insertTicket(db, "A1", { epic: "a", status: "open", effort: null });
    insertTicket(db, "A2", { epic: "a", status: "open", effort: null });
    // epic b: 1 done of 2 tickets, 0 points -> 50%
    insertTicket(db, "B1", { epic: "b", status: "done", effort: null });
    insertTicket(db, "B2", { epic: "b", status: "open", effort: null });
    // epic c: 1 done of 3 points -> 33%
    insertTicket(db, "C1", { epic: "c", status: "done", effort: 1 });
    insertTicket(db, "C2", { epic: "c", status: "open", effort: 2 });

    const result = await tool.handle(tool.parseArgs({ project: "proj1", by: "epic" }));

    expect(result.groups!.map((g) => g.key)).toEqual(["a", "c", "b"]);
    expect(result.groups!.map((g) => g.pct)).toEqual([0, 33, 50]);
  });

  it("project: 'all' with by: 'epic' merges a shared epic across projects", async () => {
    const { db, tool } = setup();
    const dir2 = makeTmpDir();
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("proj2", "Project Two", dir2, "2026-01-01T00:00:00.000Z");

    insertTicket(db, "T1", { projectId: "proj1", epic: "core", status: "open", effort: 1 });
    insertTicket(db, "T1", { projectId: "proj2", epic: "core", status: "done", effort: 1 });

    const result = await tool.handle(tool.parseArgs({ project: "all", by: "epic" }));

    expect(result.groups).toHaveLength(1);
    expect(result.groups![0]!.key).toBe("core");
    expect(result.groups![0]!.tickets).toBe(2);
  });

  it("by: 'tag' → tag counts a ticket once per tag, group totals can exceed project total", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1", { status: "open", effort: 1 });
    insertTicket(db, "T2", { status: "done", effort: 1 });
    db.prepare("INSERT INTO tags (project_id, ticket_id, tag) VALUES (?, ?, ?)").run(
      "proj1",
      "T1",
      "a",
    );
    db.prepare("INSERT INTO tags (project_id, ticket_id, tag) VALUES (?, ?, ?)").run(
      "proj1",
      "T1",
      "b",
    );

    const result = await tool.handle(tool.parseArgs({ project: "proj1", by: "tag" }));

    const keys = result.groups!.map((g) => g.key).sort();
    expect(keys).toEqual(["(none)", "a", "b"]);

    const groupTicketSum = result.groups!.reduce((sum, g) => sum + g.tickets, 0);
    expect(groupTicketSum).toBe(3);
    expect(result.totals.tickets).toBe(2);
    expect(groupTicketSum).toBeGreaterThan(result.totals.tickets);
  });

  it("progress --help mentions the by enum and the tag double-count", async () => {
    const { tool } = setup();
    const help = buildCommandHelp(tool);

    expect(help).toContain("one of: epic|parent|type|tag");
    expect(help).toContain("exceed");
  });

  it("byte budget: 20 tickets across 4 epics, by: 'epic', < 800 bytes", async () => {
    const { db, tool } = setup();
    const epics = ["alpha", "beta", "gamma", "delta"];
    const fib = [1, 2, 3, 5, 8, 13];
    for (let i = 1; i <= 20; i++) {
      insertTicket(db, `T${i}`, {
        epic: epics[i % epics.length],
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

    const result = await tool.handle(tool.parseArgs({ project: "proj1", by: "epic" }));
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(800);
  });
});
