import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeRelatedTool } from "./related.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-related-test-"));
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
  function addTicket(id?: string, title?: string) {
    seq++;
    const tid = id ?? `T${seq}`;
    db.prepare(
      "INSERT INTO tickets (id, project_id, title, status, type, created_at) VALUES (?, ?, ?, 'open', 'task', ?)",
    ).run(tid, "proj1", title ?? `Ticket ${seq}`, "2026-01-01T00:00:00.000Z");
    return tid;
  }

  function addRelation(fromId: string, toId: string, kind: string, note?: string) {
    db.prepare(
      "INSERT INTO relations (project_id, from_id, to_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("proj1", fromId, toId, kind, note ?? null, "2026-01-01T00:00:00.000Z");
  }

  const tool = makeRelatedTool(db);

  async function related(id: string, opts: { kinds?: string[]; depth?: number } = {}) {
    return tool.handle(tool.parseArgs({ project: "proj1", id, ...opts }));
  }

  return { db, addTicket, addRelation, related };
}

describe("tickets.related", () => {
  it("groups direct in + out relations by direction and kind", async () => {
    const { addTicket, addRelation, related } = setup();
    addTicket("T1", "Root");
    addTicket("T2", "Child");
    addTicket("T3", "Parent");
    addRelation("T1", "T2", "blocks");        // outgoing blocks
    addRelation("T3", "T1", "relates_to");    // incoming relates_to

    const result = await related("T1");
    expect(result.outgoing["blocks"]).toBeDefined();
    expect(result.outgoing["blocks"]![0]!.id).toBe("T2");
    expect(result.outgoing["blocks"]![0]!.depth).toBe(1);
    expect(result.incoming["relates_to"]).toBeDefined();
    expect(result.incoming["relates_to"]![0]!.id).toBe("T3");
  });

  it("enriches related items with title and status", async () => {
    const { addTicket, addRelation, related } = setup();
    addTicket("T1", "Root");
    addTicket("T2", "Connected");
    addRelation("T1", "T2", "blocks");

    const result = await related("T1");
    const item = result.outgoing["blocks"]![0]!;
    expect(item.title).toBe("Connected");
    expect(item.status).toBe("open");
  });

  it("depth 2 surfaces second-hop with depth=2", async () => {
    const { addTicket, addRelation, related } = setup();
    addTicket("T1", "One");
    addTicket("T2", "Two");
    addTicket("T3", "Three");
    addRelation("T1", "T2", "blocks");
    addRelation("T2", "T3", "blocks");

    const result = await related("T1", { depth: 2 });
    const allItems = [...(result.outgoing["blocks"] ?? [])];
    const t3Item = allItems.find((i) => i.id === "T3");
    expect(t3Item).toBeDefined();
    expect(t3Item!.depth).toBe(2);
  });

  it("kinds filter restricts results", async () => {
    const { addTicket, addRelation, related } = setup();
    addTicket("T1", "One");
    addTicket("T2", "Two");
    addTicket("T3", "Three");
    addRelation("T1", "T2", "blocks");
    addRelation("T1", "T3", "relates_to");

    const result = await related("T1", { kinds: ["blocks"] });
    expect(result.outgoing["blocks"]).toBeDefined();
    expect(result.outgoing["relates_to"]).toBeUndefined();
    expect(result.incoming["relates_to"]).toBeUndefined();
  });

  it("non-existent id → InvalidParams", async () => {
    const { related } = setup();
    await expect(related("NO-SUCH")).rejects.toThrow(McpError);
  });

  it("no relations → empty outgoing and incoming", async () => {
    const { addTicket, related } = setup();
    addTicket("T1", "Lone");

    const result = await related("T1");
    expect(Object.keys(result.outgoing)).toHaveLength(0);
    expect(Object.keys(result.incoming)).toHaveLength(0);
  });

  it("token budget: result JSON < 1000*4 bytes", async () => {
    const { addTicket, addRelation, related, db } = setup();
    addTicket("T1", "Root");
    for (let i = 2; i <= 5; i++) {
      addTicket(`T${i}`, `Ticket ${i}`);
      addRelation("T1", `T${i}`, "relates_to");
    }

    const result = await related("T1", { depth: 2 });
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(1000 * 4);
    db.close();
  });
});
