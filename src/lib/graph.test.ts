import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { walkRelations, walkChildren } from "./graph.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-graph-test-"));
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

  function addTicket(id: string, title: string, parentId?: string) {
    db.prepare(
      "INSERT INTO tickets (id, project_id, title, status, type, created_at) VALUES (?, ?, ?, 'open', 'task', ?)",
    ).run(id, "proj1", title, "2026-01-01T00:00:00.000Z");
    if (parentId) {
      db.prepare("UPDATE tickets SET parent_id = ? WHERE project_id = ? AND id = ?")
        .run(parentId, "proj1", id);
    }
  }

  function addRelation(fromId: string, toId: string, kind: string, note?: string) {
    db.prepare(
      "INSERT INTO relations (project_id, from_id, to_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("proj1", fromId, toId, kind, note ?? null, "2026-01-01T00:00:00.000Z");
  }

  return { db, addTicket, addRelation };
}

describe("walkRelations", () => {
  it("outgoing depth 1 returns direct edges only", () => {
    const { db, addTicket, addRelation } = setup();
    addTicket("T1", "One");
    addTicket("T2", "Two");
    addTicket("T3", "Three");
    // T1 -> T2 (blocks), T2 -> T3 (blocks)
    addRelation("T1", "T2", "blocks");
    addRelation("T2", "T3", "blocks");

    const nodes = walkRelations(db, { projectId: "proj1", startId: "T1", direction: "outgoing", maxDepth: 1 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe("T2");
    expect(nodes[0]!.depth).toBe(1);
    expect(nodes[0]!.direction).toBe("outgoing");
    db.close();
  });

  it("depth 2 returns the second hop with depth=2", () => {
    const { db, addTicket, addRelation } = setup();
    addTicket("T1", "One");
    addTicket("T2", "Two");
    addTicket("T3", "Three");
    addRelation("T1", "T2", "blocks");
    addRelation("T2", "T3", "blocks");

    const nodes = walkRelations(db, { projectId: "proj1", startId: "T1", direction: "outgoing", maxDepth: 2 });
    expect(nodes).toHaveLength(2);
    const t3 = nodes.find((n) => n.id === "T3");
    expect(t3).toBeDefined();
    expect(t3!.depth).toBe(2);
    db.close();
  });

  it("terminates on a relates_to cycle (visited guard)", () => {
    const { db, addTicket, addRelation } = setup();
    addTicket("T1", "One");
    addTicket("T2", "Two");
    // relates_to is symmetric: T1->T2 means T2 relates_to T1 too (via incoming)
    addRelation("T1", "T2", "relates_to");

    // With direction "both" this would see T1 from T2 as incoming, then T2 from T1 again — cycle.
    const nodes = walkRelations(db, { projectId: "proj1", startId: "T1", direction: "both", maxDepth: 3 });
    // Should only contain T2 once, not loop infinitely.
    const ids = nodes.map((n) => n.id);
    expect(ids.filter((id) => id === "T2")).toHaveLength(1);
    db.close();
  });

  it("kinds filter restricts followed edges", () => {
    const { db, addTicket, addRelation } = setup();
    addTicket("T1", "One");
    addTicket("T2", "Two");
    addTicket("T3", "Three");
    addRelation("T1", "T2", "blocks");
    addRelation("T1", "T3", "relates_to");

    const nodes = walkRelations(db, {
      projectId: "proj1",
      startId: "T1",
      kinds: ["blocks"],
      direction: "outgoing",
      maxDepth: 1,
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe("T2");
    db.close();
  });

  it("incoming direction finds nodes pointing to startId", () => {
    const { db, addTicket, addRelation } = setup();
    addTicket("T1", "One");
    addTicket("T2", "Two");
    addRelation("T2", "T1", "blocks"); // T2 blocks T1

    const nodes = walkRelations(db, { projectId: "proj1", startId: "T1", direction: "incoming", maxDepth: 1 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe("T2");
    expect(nodes[0]!.direction).toBe("incoming");
    db.close();
  });

  it("start node not in result", () => {
    const { db, addTicket, addRelation } = setup();
    addTicket("T1", "One");
    addTicket("T2", "Two");
    addRelation("T1", "T2", "blocks");

    const nodes = walkRelations(db, { projectId: "proj1", startId: "T1", direction: "both", maxDepth: 3 });
    expect(nodes.map((n) => n.id)).not.toContain("T1");
    db.close();
  });
});

describe("walkChildren", () => {
  it("returns descendants with correct depth", () => {
    const { db, addTicket } = setup();
    addTicket("T1", "One");
    addTicket("T2", "Two", "T1");
    addTicket("T3", "Three", "T2");

    const nodes = walkChildren(db, { projectId: "proj1", parentId: "T1", maxDepth: 2 });
    expect(nodes).toHaveLength(2);
    const t2 = nodes.find((n) => n.id === "T2");
    const t3 = nodes.find((n) => n.id === "T3");
    expect(t2!.depth).toBe(1);
    expect(t2!.parent_id).toBe("T1");
    expect(t3!.depth).toBe(2);
    expect(t3!.parent_id).toBe("T2");
    db.close();
  });

  it("on a leaf returns empty array", () => {
    const { db, addTicket } = setup();
    addTicket("T1", "One");

    const nodes = walkChildren(db, { projectId: "proj1", parentId: "T1", maxDepth: 2 });
    expect(nodes).toHaveLength(0);
    db.close();
  });

  it("respects maxDepth", () => {
    const { db, addTicket } = setup();
    addTicket("T1", "One");
    addTicket("T2", "Two", "T1");
    addTicket("T3", "Three", "T2");

    const nodes = walkChildren(db, { projectId: "proj1", parentId: "T1", maxDepth: 1 });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe("T2");
    db.close();
  });

  it("parent not in result", () => {
    const { db, addTicket } = setup();
    addTicket("T1", "One");
    addTicket("T2", "Two", "T1");

    const nodes = walkChildren(db, { projectId: "proj1", parentId: "T1", maxDepth: 2 });
    expect(nodes.map((n) => n.id)).not.toContain("T1");
    db.close();
  });
});
