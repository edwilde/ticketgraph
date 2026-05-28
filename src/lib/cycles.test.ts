import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { wouldCreateCycle } from "./cycles.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-cycles-test-"));
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
  ).run("p1", "Project One", dir, "2026-01-01T00:00:00.000Z");

  function addTicket(id: string, parentId: string | null = null) {
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, "p1", id, "", "open", parentId, "2026-01-01T00:00:00.000Z");
  }

  return { db, addTicket };
}

describe("wouldCreateCycle", () => {
  it("no existing parent chain → false", () => {
    const { db, addTicket } = setup();
    addTicket("A");
    addTicket("B");
    // Set B's parent to A — A has no parent, so no cycle.
    expect(wouldCreateCycle(db, { projectId: "p1", ticketId: "B", newParentId: "A" })).toBe(false);
    db.close();
  });

  it("linear chain (A→B→C, set C's parent to A) → false (A is above C, no new cycle)", () => {
    const { db, addTicket } = setup();
    addTicket("A");
    addTicket("B", "A");
    addTicket("C", "B");
    // C's new parent would be A — walking from A upward: A has no parent, no cycle.
    expect(wouldCreateCycle(db, { projectId: "p1", ticketId: "C", newParentId: "A" })).toBe(false);
    db.close();
  });

  it("direct self-loop attempt (set A's parent to A) → true", () => {
    const { db, addTicket } = setup();
    addTicket("A");
    expect(wouldCreateCycle(db, { projectId: "p1", ticketId: "A", newParentId: "A" })).toBe(true);
    db.close();
  });

  it("two-step loop attempt (A→B exists, set B's parent to A) → true", () => {
    const { db, addTicket } = setup();
    addTicket("A");
    addTicket("B", "A"); // B's parent is A
    // Now try to set A's parent to B — walking from B: B.parent = A = ticketId → cycle
    expect(wouldCreateCycle(db, { projectId: "p1", ticketId: "A", newParentId: "B" })).toBe(true);
    db.close();
  });

  it("deep chain (10 levels) → false for valid append at bottom", () => {
    const { db, addTicket } = setup();
    addTicket("T1");
    for (let i = 2; i <= 10; i++) {
      addTicket(`T${i}`, `T${i - 1}`);
    }
    addTicket("T11"); // no parent yet
    // Set T11's parent to T10 — walking from T10 up to T1, never sees T11
    expect(wouldCreateCycle(db, { projectId: "p1", ticketId: "T11", newParentId: "T10" })).toBe(false);
    db.close();
  });

  it("hard cap triggers and throws if DB already has a cycle", () => {
    const { db, addTicket } = setup();
    // Manually insert a cycle by bypassing FK (insert then raw UPDATE to create cycle)
    addTicket("X");
    addTicket("Y", "X");
    // Force X's parent to Y directly (creating X→Y→X cycle)
    db.prepare("UPDATE tickets SET parent_id = ? WHERE project_id = ? AND id = ?").run("Y", "p1", "X");

    // Now walk from X — should hit the cap
    expect(() =>
      wouldCreateCycle(db, { projectId: "p1", ticketId: "Z", newParentId: "X" }),
    ).toThrow(/pre-existing cycle/);
    db.close();
  });
});
