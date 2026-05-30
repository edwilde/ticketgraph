import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { collectProjectExport } from "./export-collect.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-export-collect-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function openFreshDb() {
  return openDb({ path: join(makeTmpDir(), "test.db") }).db;
}

function seedProject(db: ReturnType<typeof openFreshDb>, id = "proj1") {
  db.prepare(
    "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
  ).run(id, "Project", `/tmp/${id}`, "2026-01-01T00:00:00.000Z");
}

function addTicket(
  db: ReturnType<typeof openFreshDb>,
  id: string,
  opts: {
    projectId?: string;
    status?: string;
    priority?: string | null;
    title?: string;
  } = {},
) {
  const { projectId = "proj1", status = "open", priority = null, title = "A ticket" } = opts;
  db.prepare(
    `INSERT INTO tickets (id, project_id, title, description, status, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, title, "", status, priority, "2026-01-01T00:00:00.000Z");
}

function addTag(
  db: ReturnType<typeof openFreshDb>,
  projectId: string,
  ticketId: string,
  tag: string,
) {
  db.prepare(
    "INSERT INTO tags (project_id, ticket_id, tag) VALUES (?, ?, ?)",
  ).run(projectId, ticketId, tag);
}

function addRelation(
  db: ReturnType<typeof openFreshDb>,
  projectId: string,
  fromId: string,
  toId: string,
  kind: string,
  note: string | null = null,
) {
  db.prepare(
    "INSERT INTO relations (project_id, from_id, to_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(projectId, fromId, toId, kind, note, "2026-01-01T00:00:00.000Z");
}

describe("collectProjectExport", () => {
  it("returns every ticket regardless of status, with no limit", () => {
    const db = openFreshDb();
    seedProject(db);
    const statuses = ["open", "in_progress", "blocked", "done", "deferred"];
    statuses.forEach((status, i) => {
      addTicket(db, `T${i + 1}`, { status });
    });

    const { tickets } = collectProjectExport(db, "proj1");
    const returnedStatuses = tickets.map((t) => t.status).sort();
    expect(returnedStatuses).toEqual([...statuses].sort());
    expect(tickets).toHaveLength(5);

    // All tickets have no tags or relations — assert empty-contract defaults.
    const t = tickets[0]!;
    expect(t.tags).toEqual([]);
    expect(t.relations).toEqual({ outgoing: {}, incoming: {} });

    db.close();
  });

  it("attaches tags and grouped relations to each ticket", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "T1");
    addTicket(db, "T2");
    addTag(db, "proj1", "T1", "urgent");
    addTag(db, "proj1", "T1", "backend");
    // T2 blocks T1 (incoming blocks on T1, outgoing blocks on T2)
    addRelation(db, "proj1", "T2", "T1", "blocks");
    // T1 relates_to T2 (outgoing relates_to on T1)
    addRelation(db, "proj1", "T1", "T2", "relates_to");

    const { tickets } = collectProjectExport(db, "proj1");
    const t1 = tickets.find((t) => t.id === "T1")!;
    expect(t1).toBeDefined();
    expect(t1.tags.sort()).toEqual(["backend", "urgent"]);

    // T2 blocks T1 → incoming "blocks" on T1
    expect(t1.relations.incoming["blocks"]).toBeDefined();
    expect(t1.relations.incoming["blocks"]!.map((e) => e.id)).toContain("T2");

    // T1 relates_to T2 → outgoing "relates_to" on T1
    expect(t1.relations.outgoing["relates_to"]).toBeDefined();
    expect(t1.relations.outgoing["relates_to"]!.map((e) => e.id)).toContain("T2");

    db.close();
  });

  it("places no-priority and unknown-priority tickets after P3, not first", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "T1", { priority: "P0" });
    addTicket(db, "T2", { priority: "P3" });
    addTicket(db, "T3", { priority: null });   // null priority
    addTicket(db, "T4", { priority: "P1" });

    const { tickets } = collectProjectExport(db, "proj1");
    const ids = tickets.map((t) => t.id);

    // T1 (P0) must come before T3 (null)
    expect(ids.indexOf("T1")).toBeLessThan(ids.indexOf("T3"));
    // T4 (P1) must come before T3 (null)
    expect(ids.indexOf("T4")).toBeLessThan(ids.indexOf("T3"));
    // T2 (P3) must come before T3 (null)
    expect(ids.indexOf("T2")).toBeLessThan(ids.indexOf("T3"));

    db.close();
  });

  it("computes status counts", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "T1", { status: "open" });
    addTicket(db, "T2", { status: "open" });
    addTicket(db, "T3", { status: "in_progress" });
    addTicket(db, "T4", { status: "done" });
    addTicket(db, "T5", { status: "done" });
    addTicket(db, "T6", { status: "done" });
    addTicket(db, "T7", { status: "deferred" });

    const { statusCounts } = collectProjectExport(db, "proj1");
    expect(statusCounts["open"]).toBe(2);
    expect(statusCounts["in_progress"]).toBe(1);
    expect(statusCounts["done"]).toBe(3);
    expect(statusCounts["deferred"]).toBe(1);
    expect(statusCounts["blocked"]).toBeUndefined();

    db.close();
  });
});
