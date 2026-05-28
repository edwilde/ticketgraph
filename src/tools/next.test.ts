import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { makeNextTool } from "./next.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-next-test-"));
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
  db.prepare(
    "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
  ).run("proj1", "Project One", dir, "2026-01-01T00:00:00.000Z");

  let seq = 0;
  function addTicket(opts: {
    id?: string;
    title?: string;
    status?: string;
    priority?: string | null;
    type?: string;
    created_at?: string;
  } = {}) {
    seq++;
    const id = opts.id ?? `T${seq}`;
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, status, priority, type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      "proj1",
      opts.title ?? `Ticket ${seq}`,
      opts.status ?? "open",
      opts.priority ?? null,
      opts.type ?? "task",
      opts.created_at ?? "2026-01-01T00:00:00.000Z",
    );
    return id;
  }

  function addRelation(fromId: string, toId: string, kind: string) {
    db.prepare(
      "INSERT INTO relations (project_id, from_id, to_id, kind, note, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
    ).run("proj1", fromId, toId, kind, "2026-01-01T00:00:00.000Z");
  }

  const tool = makeNextTool(db);

  async function next(opts: { type?: string } = {}) {
    return tool.handle(tool.parseArgs({ project: "proj1", ...opts }));
  }

  return { db, addTicket, addRelation, next };
}

describe("tickets.next", () => {
  it("picks highest priority (P0 before P1 before null)", async () => {
    const { addTicket, next } = setup();
    addTicket({ id: "A", priority: null });
    addTicket({ id: "B", priority: "P1" });
    addTicket({ id: "C", priority: "P0" });

    const result = await next();
    expect(result.ticket!.id).toBe("C");
    expect(result.reason!.priority).toBe("P0");
    expect(result.reason!.no_open_blockers).toBe(true);
  });

  it("skips a ticket blocked by an open blocker", async () => {
    const { addTicket, addRelation, next } = setup();
    const blocker = addTicket({ id: "BLOCK", priority: "P0", status: "open" });
    const blocked = addTicket({ id: "WAIT", priority: "P0" });
    addRelation(blocker, blocked, "blocks");

    const result = await next();
    // WAIT is blocked by BLOCK (open) → not eligible; BLOCK itself is eligible
    expect(result.ticket!.id).toBe("BLOCK");
  });

  it("a ticket blocked only by a DONE blocker IS eligible", async () => {
    const { addTicket, addRelation, next } = setup();
    const blocker = addTicket({ id: "DONE", priority: "P1", status: "done" });
    // Update status to done directly
    const { db } = setup();
    db.close();

    // Use the same db from the first setup
    const dir = makeTmpDir();
    const { db: db2 } = openDb({ path: join(dir, "test.db") });
    db2.prepare("INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)")
      .run("p2", "P2", dir, "2026-01-01T00:00:00.000Z");
    db2.prepare("INSERT INTO tickets (id, project_id, title, status, priority, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("DONE", "p2", "Done ticket", "done", "P1", "task", "2026-01-01T00:00:00.000Z");
    db2.prepare("INSERT INTO tickets (id, project_id, title, status, priority, type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("WAIT", "p2", "Waiting ticket", "open", "P0", "task", "2026-01-02T00:00:00.000Z");
    db2.prepare("INSERT INTO relations (project_id, from_id, to_id, kind, note, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
      .run("p2", "DONE", "WAIT", "blocks", "2026-01-01T00:00:00.000Z");

    const tool2 = makeNextTool(db2);
    const result = await tool2.handle(tool2.parseArgs({ project: "p2" }));
    // WAIT is blocked only by DONE (done status) → eligible
    expect(result.ticket!.id).toBe("WAIT");
    db2.close();
  });

  it("type filter narrows candidates", async () => {
    const { addTicket, next } = setup();
    addTicket({ id: "BUG1", type: "bug", priority: "P0" });
    addTicket({ id: "TASK1", type: "task", priority: "P1" });

    const result = await next({ type: "task" });
    expect(result.ticket!.id).toBe("TASK1");
    expect(result.ticket!.type).toBe("task");
  });

  it("ties broken by created_at then id", async () => {
    const { addTicket, next } = setup();
    addTicket({ id: "B", priority: "P1", created_at: "2026-01-02T00:00:00.000Z" });
    addTicket({ id: "A", priority: "P1", created_at: "2026-01-01T00:00:00.000Z" });

    const result = await next();
    expect(result.ticket!.id).toBe("A");
  });

  it("empty project → { ticket: null, reason: null }", async () => {
    const { next } = setup();
    const result = await next();
    expect(result.ticket).toBeNull();
    expect(result.reason).toBeNull();
  });

  it("all tickets blocked → { ticket: null, reason: null }", async () => {
    const { addTicket, addRelation, next } = setup();
    const b = addTicket({ id: "B1", status: "open" });
    const w = addTicket({ id: "W1", status: "open" });
    addRelation(b, w, "blocks");
    addRelation(w, b, "blocks"); // both block each other

    const result = await next();
    // Neither is eligible since each blocks the other and both are open
    expect(result.ticket).toBeNull();
  });

  it("reason includes age_days as non-negative integer", async () => {
    const { addTicket, next } = setup();
    addTicket({ id: "T1" });
    const result = await next();
    expect(result.reason!.age_days).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.reason!.age_days)).toBe(true);
  });

  it("token budget: result JSON < 300*4 bytes", async () => {
    const { addTicket, next } = setup();
    addTicket({ id: "T1", priority: "P0" });
    const result = await next();
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(300 * 4);
  });
});
