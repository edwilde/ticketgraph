import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeChildrenOfTool } from "./children_of.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-children-test-"));
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
  function addTicket(id?: string, parentId?: string, status = "open") {
    seq++;
    const tid = id ?? `T${seq}`;
    db.prepare(
      "INSERT INTO tickets (id, project_id, title, status, type, parent_id, created_at) VALUES (?, ?, ?, ?, 'task', ?, ?)",
    ).run(tid, "proj1", `Ticket ${tid}`, status, parentId ?? null, "2026-01-01T00:00:00.000Z");
    return tid;
  }

  const tool = makeChildrenOfTool(db);

  async function childrenOf(id: string, depth?: number) {
    return tool.handle(tool.parseArgs({ project: "proj1", id, ...(depth !== undefined ? { depth } : {}) }));
  }

  return { db, addTicket, childrenOf };
}

describe("tickets.children_of", () => {
  it("returns descendant tree to depth 2", async () => {
    const { addTicket, childrenOf } = setup();
    addTicket("ROOT");
    addTicket("C1", "ROOT");
    addTicket("C2", "ROOT");
    addTicket("C1A", "C1");

    const result = await childrenOf("ROOT");
    expect(result.children).toHaveLength(3);
    const c1 = result.children.find((c) => c.id === "C1");
    const c2 = result.children.find((c) => c.id === "C2");
    const c1a = result.children.find((c) => c.id === "C1A");
    expect(c1!.depth).toBe(1);
    expect(c1!.parent_id).toBe("ROOT");
    expect(c2!.depth).toBe(1);
    expect(c1a!.depth).toBe(2);
    expect(c1a!.parent_id).toBe("C1");
  });

  it("enriches children with title and status", async () => {
    const { addTicket, childrenOf } = setup();
    addTicket("ROOT");
    addTicket("C1", "ROOT", "in_progress");

    const result = await childrenOf("ROOT");
    expect(result.children[0]!.title).toBe("Ticket C1");
    expect(result.children[0]!.status).toBe("in_progress");
  });

  it("depth clamp at 3", async () => {
    const { addTicket, childrenOf } = setup();
    addTicket("ROOT");
    addTicket("C1", "ROOT");
    addTicket("C2", "C1");
    addTicket("C3", "C2");
    addTicket("C4", "C3"); // depth 4 — excluded

    const result = await childrenOf("ROOT", 10); // clamped to 3
    const ids = result.children.map((c) => c.id);
    expect(ids).toContain("C1");
    expect(ids).toContain("C2");
    expect(ids).toContain("C3");
    expect(ids).not.toContain("C4");
  });

  it("leaf ticket → empty children", async () => {
    const { addTicket, childrenOf } = setup();
    addTicket("ROOT");

    const result = await childrenOf("ROOT");
    expect(result.children).toHaveLength(0);
  });

  it("non-existent id → InvalidParams", async () => {
    const { childrenOf } = setup();
    await expect(childrenOf("NO-SUCH")).rejects.toThrow(McpError);
  });

  it("results ordered by depth then id", async () => {
    const { addTicket, childrenOf } = setup();
    addTicket("ROOT");
    addTicket("Z1", "ROOT");
    addTicket("A1", "ROOT");

    const result = await childrenOf("ROOT");
    expect(result.children[0]!.id).toBe("A1");
    expect(result.children[1]!.id).toBe("Z1");
  });

  it("root ticket not in result", async () => {
    const { addTicket, childrenOf } = setup();
    addTicket("ROOT");
    addTicket("C1", "ROOT");

    const result = await childrenOf("ROOT");
    expect(result.children.map((c) => c.id)).not.toContain("ROOT");
  });

  it("token budget: result JSON < 1500*4 bytes", async () => {
    const { addTicket, childrenOf, db } = setup();
    addTicket("ROOT");
    for (let i = 1; i <= 8; i++) {
      addTicket(`C${i}`, "ROOT");
    }
    const result = await childrenOf("ROOT");
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(1500 * 4);
    db.close();
  });
});
