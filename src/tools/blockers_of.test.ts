import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeBlockersOfTool } from "./blockers_of.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-blockers-test-"));
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
  function addTicket(id?: string, status = "open") {
    seq++;
    const tid = id ?? `T${seq}`;
    db.prepare(
      "INSERT INTO tickets (id, project_id, title, status, type, created_at) VALUES (?, ?, ?, ?, 'task', ?)",
    ).run(tid, "proj1", `Ticket ${tid}`, status, "2026-01-01T00:00:00.000Z");
    return tid;
  }

  function addRelation(fromId: string, toId: string, kind: string) {
    db.prepare(
      "INSERT INTO relations (project_id, from_id, to_id, kind, note, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
    ).run("proj1", fromId, toId, kind, "2026-01-01T00:00:00.000Z");
  }

  const tool = makeBlockersOfTool(db);

  async function blockersOf(id: string, depth?: number) {
    return tool.handle(tool.parseArgs({ project: "proj1", id, ...(depth !== undefined ? { depth } : {}) }));
  }

  return { db, addTicket, addRelation, blockersOf };
}

describe("tickets.blockers_of", () => {
  it("returns incoming blocks chain to depth 2", async () => {
    const { addTicket, addRelation, blockersOf } = setup();
    addTicket("ROOT");
    addTicket("B1");   // B1 blocks ROOT
    addTicket("B2");   // B2 blocks B1
    addRelation("B1", "ROOT", "blocks");
    addRelation("B2", "B1", "blocks");

    const result = await blockersOf("ROOT");
    expect(result.blockers).toHaveLength(2);
    const b1 = result.blockers.find((b) => b.id === "B1");
    const b2 = result.blockers.find((b) => b.id === "B2");
    expect(b1!.depth).toBe(1);
    expect(b2!.depth).toBe(2);
  });

  it("excludes outgoing blocks (those are tickets ROOT blocks, not blockers of ROOT)", async () => {
    const { addTicket, addRelation, blockersOf } = setup();
    addTicket("ROOT");
    addTicket("DOWNSTREAM"); // ROOT blocks DOWNSTREAM
    addRelation("ROOT", "DOWNSTREAM", "blocks");

    const result = await blockersOf("ROOT");
    expect(result.blockers).toHaveLength(0);
  });

  it("enriches blockers with title and status", async () => {
    const { addTicket, addRelation, blockersOf } = setup();
    addTicket("ROOT");
    addTicket("B1", "in_progress");
    addRelation("B1", "ROOT", "blocks");

    const result = await blockersOf("ROOT");
    expect(result.blockers[0]!.title).toBe("Ticket B1");
    expect(result.blockers[0]!.status).toBe("in_progress");
  });

  it("depth clamp at 3", async () => {
    const { addTicket, addRelation, blockersOf } = setup();
    addTicket("ROOT");
    addTicket("B1"); addTicket("B2"); addTicket("B3"); addTicket("B4");
    addRelation("B1", "ROOT", "blocks");
    addRelation("B2", "B1", "blocks");
    addRelation("B3", "B2", "blocks");
    addRelation("B4", "B3", "blocks"); // depth 4 — should be excluded

    const result = await blockersOf("ROOT", 10); // even if user asks 10, clamped to 3
    const ids = result.blockers.map((b) => b.id);
    expect(ids).toContain("B1");
    expect(ids).toContain("B2");
    expect(ids).toContain("B3");
    expect(ids).not.toContain("B4");
  });

  it("non-existent id → InvalidParams", async () => {
    const { blockersOf } = setup();
    await expect(blockersOf("NO-SUCH")).rejects.toThrow(McpError);
  });

  it("no blockers → empty array", async () => {
    const { addTicket, blockersOf } = setup();
    addTicket("ROOT");
    const result = await blockersOf("ROOT");
    expect(result.blockers).toHaveLength(0);
  });

  it("results ordered by depth then id", async () => {
    const { addTicket, addRelation, blockersOf } = setup();
    addTicket("ROOT");
    addTicket("B2");
    addTicket("A1");
    addRelation("B2", "ROOT", "blocks");
    addRelation("A1", "ROOT", "blocks");

    const result = await blockersOf("ROOT");
    expect(result.blockers[0]!.id).toBe("A1");
    expect(result.blockers[1]!.id).toBe("B2");
  });

  it("token budget: result JSON < 1000*4 bytes", async () => {
    const { addTicket, addRelation, blockersOf, db } = setup();
    addTicket("ROOT");
    for (let i = 1; i <= 5; i++) {
      addTicket(`B${i}`);
      addRelation(`B${i}`, "ROOT", "blocks");
    }
    const result = await blockersOf("ROOT");
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(1000 * 4);
    db.close();
  });
});
