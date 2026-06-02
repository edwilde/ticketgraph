import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeAddTool } from "./add.js";
import { makeUpdateTool } from "./update.js";
import { makeChangedSinceTool } from "./changed_since.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-changed-since-test-"));
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

  const addTool = makeAddTool(db);
  const updateTool = makeUpdateTool(db);
  const tool = makeChangedSinceTool(db);

  async function addTicket(title = "Test ticket") {
    const r = await addTool.handle(addTool.parseArgs({ project: "proj1", title, full: true }));
    if (!("ticket" in r)) throw new Error("expected full add result");
    return r.ticket;
  }

  async function updateTicket(id: string, patch: Record<string, unknown>) {
    return updateTool.handle(updateTool.parseArgs({ project: "proj1", id, patch }));
  }

  async function changedSince(opts: {
    since: string;
    field?: string;
    new_value?: string;
    limit?: number;
  }) {
    return tool.handle(tool.parseArgs({ project: "proj1", ...opts }));
  }

  return { db, addTicket, updateTicket, changedSince };
}

describe("tickets.changed_since", () => {
  it("returns rows since a timestamp, excludes older entries", async () => {
    const { addTicket, changedSince } = setup();
    await addTicket("Old ticket");

    const cutoff = new Date().toISOString();

    await addTicket("New ticket");

    const result = await changedSince({ since: cutoff });
    // Should only include the _created entry for "New ticket"
    expect(result.changes.length).toBeGreaterThanOrEqual(1);
    const ticketIds = result.changes.map((c) => c.ticket_id);
    // All returned changes are at or after cutoff.
    for (const change of result.changes) {
      expect(change.changed_at >= cutoff).toBe(true);
    }
    expect(result.count).toBe(result.changes.length);
  });

  it("field filter returns only that field", async () => {
    const { addTicket, updateTicket, changedSince } = setup();
    const t = await addTicket("Task");
    await updateTicket(t.id, { status: "in_progress" });
    await updateTicket(t.id, { priority: "P1" });

    const result = await changedSince({ since: "2000-01-01", field: "status" });
    for (const change of result.changes) {
      expect(change.field).toBe("status");
    }
    expect(result.changes.length).toBeGreaterThanOrEqual(1);
  });

  it("new_value filter returns matching rows", async () => {
    const { addTicket, updateTicket, changedSince } = setup();
    const t = await addTicket("Task");
    await updateTicket(t.id, { status: "done" });
    await updateTicket(t.id, { status: "open" });

    const result = await changedSince({ since: "2000-01-01", field: "status", new_value: "done" });
    expect(result.changes.length).toBeGreaterThanOrEqual(1);
    for (const change of result.changes) {
      expect(change.new_value).toBe("done");
    }
  });

  it("limit clamp: requesting > 500 is clamped to 500", async () => {
    const { changedSince } = setup();
    // Should not throw — just clamp.
    const result = await changedSince({ since: "2000-01-01", limit: 9999 });
    expect(result.count).toBeLessThanOrEqual(500);
  });

  it("bad since → InvalidParams", () => {
    const dir = makeTmpDir();
    const { db } = openDb({ path: join(dir, "test.db") });
    db.prepare("INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)")
      .run("p2", "P2", dir, "2026-01-01T00:00:00.000Z");
    const tool = makeChangedSinceTool(db);

    expect(() => tool.parseArgs({ project: "p2", since: "not-a-date" })).toThrow(McpError);
    db.close();
  });

  it("missing since → InvalidParams", async () => {
    const { db } = setup();
    const tool = makeChangedSinceTool(db);
    expect(() => tool.parseArgs({ project: "proj1" })).toThrow(McpError);
    db.close();
  });

  it("results sorted changed_at DESC", async () => {
    const { addTicket, updateTicket, changedSince } = setup();
    const t = await addTicket("Task");
    await updateTicket(t.id, { status: "in_progress" });
    await updateTicket(t.id, { priority: "P1" });

    const result = await changedSince({ since: "2000-01-01" });
    for (let i = 1; i < result.changes.length; i++) {
      expect(result.changes[i - 1]!.changed_at >= result.changes[i]!.changed_at).toBe(true);
    }
  });

  it("token budget: result JSON < 1000*4 bytes", async () => {
    const { addTicket, updateTicket, changedSince, db } = setup();
    const t = await addTicket("Task");
    await updateTicket(t.id, { status: "in_progress" });

    const result = await changedSince({ since: "2000-01-01" });
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(1000 * 4);
    db.close();
  });
});
