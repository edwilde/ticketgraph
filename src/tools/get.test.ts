import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeGetTool } from "./get.js";
import { writeAudit } from "../lib/audit.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-get-test-"));
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
  const tool = makeGetTool(db);

  db.prepare(
    "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
  ).run("proj1", "Project One", dir, "2026-01-01T00:00:00.000Z");

  return { db, tool };
}

function insertTicket(
  db: ReturnType<typeof setup>["db"],
  id: string,
  projectId = "proj1",
) {
  db.prepare(
    `INSERT INTO tickets (id, project_id, title, description, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, `Title ${id}`, `Description of ${id}`, "open", "2026-01-01T00:00:00.000Z");
}

describe("tickets.get — single id", () => {
  it("returns full ticket for a known id", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1");

    const result = await tool.handle(tool.parseArgs({ project: "proj1", id: "T1" }));
    expect("ticket" in result).toBe(true);
    const r = result as { ticket: { id: string; tags: string[]; relations: unknown; recent_audit: unknown[] } };
    expect(r.ticket.id).toBe("T1");
    expect(Array.isArray(r.ticket.tags)).toBe(true);
    expect(r.ticket.relations).toBeDefined();
    expect(Array.isArray(r.ticket.recent_audit)).toBe(true);
  });

  it("throws McpError for unknown single id", async () => {
    const { tool } = setup();
    await expect(
      tool.handle(tool.parseArgs({ project: "proj1", id: "NOTEXIST" })),
    ).rejects.toThrow(McpError);
  });

  it("includes tags", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1");
    db.prepare("INSERT INTO tags (project_id, ticket_id, tag) VALUES (?, ?, ?)").run(
      "proj1", "T1", "fts",
    );
    db.prepare("INSERT INTO tags (project_id, ticket_id, tag) VALUES (?, ?, ?)").run(
      "proj1", "T1", "search",
    );

    const result = await tool.handle(tool.parseArgs({ project: "proj1", id: "T1" }));
    const r = result as { ticket: { tags: string[] } };
    expect(r.ticket.tags.sort()).toEqual(["fts", "search"]);
  });

  it("groups relations by direction and kind", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1");
    insertTicket(db, "T2");
    insertTicket(db, "T3");

    // T1 blocks T2 (outgoing blocks from T1's perspective)
    db.prepare(
      "INSERT INTO relations (project_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("proj1", "T1", "T2", "blocks", "2026-01-01T00:00:00.000Z");
    // T3 blocks T1 (incoming blocks from T1's perspective)
    db.prepare(
      "INSERT INTO relations (project_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("proj1", "T3", "T1", "blocks", "2026-01-01T00:00:00.000Z");

    const result = await tool.handle(tool.parseArgs({ project: "proj1", id: "T1" }));
    const r = result as {
      ticket: {
        relations: {
          outgoing: Record<string, Array<{ id: string }>>;
          incoming: Record<string, Array<{ id: string }>>;
        };
      };
    };

    expect(r.ticket.relations.outgoing["blocks"]?.map((x) => x.id)).toContain("T2");
    expect(r.ticket.relations.incoming["blocks"]?.map((x) => x.id)).toContain("T3");
  });

  it("recent_audit ≤ 10 entries, sorted DESC", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1");

    // Insert 15 audit entries.
    for (let i = 1; i <= 15; i++) {
      writeAudit(db, {
        projectId: "proj1",
        ticketId: "T1",
        field: "status",
        oldValue: "open",
        newValue: "in_progress",
        changedAt: `2026-01-${String(i).padStart(2, "0")}T00:00:00.000Z`,
      });
    }

    const result = await tool.handle(tool.parseArgs({ project: "proj1", id: "T1" }));
    const r = result as {
      ticket: { recent_audit: Array<{ changed_at: string }> };
    };
    expect(r.ticket.recent_audit).toHaveLength(10);
    // First entry should be the latest.
    expect(r.ticket.recent_audit[0]!.changed_at > r.ticket.recent_audit[1]!.changed_at).toBe(true);
  });
});

describe("tickets.get — multiple ids", () => {
  it("returns array with null for missing slots", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1");

    const result = await tool.handle(
      tool.parseArgs({ project: "proj1", ids: ["T1", "NOTEXIST"] }),
    );
    expect("tickets" in result).toBe(true);
    const r = result as { tickets: Array<{ id: string } | null> };
    expect(r.tickets[0]?.id).toBe("T1");
    expect(r.tickets[1]).toBeNull();
  });

  it("parseArgs throws McpError for ids array > 10", () => {
    const { tool } = setup();
    const ids = Array.from({ length: 11 }, (_, i) => `T${i + 1}`);
    expect(() => tool.parseArgs({ project: "proj1", ids })).toThrow(McpError);
  });

  it("parseArgs throws McpError if neither id nor ids supplied", () => {
    const { tool } = setup();
    expect(() => tool.parseArgs({ project: "proj1" })).toThrow(McpError);
  });

  it("token budget: single ticket < 2000 × 4 bytes", async () => {
    const { db, tool } = setup();
    insertTicket(db, "T1");

    const result = await tool.handle(tool.parseArgs({ project: "proj1", id: "T1" }));
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(2000 * 4);
  });
});
