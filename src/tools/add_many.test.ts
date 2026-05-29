import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { openDb } from "../db.js";
import { makeAddManyTool } from "./add_many.js";

// parseArgs is pure (no DB access), but the factory requires a db handle.
// An in-memory throwaway db satisfies the signature without being touched.
function makeTool() {
  const db = new Database(":memory:");
  return makeAddManyTool(db);
}

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-add-many-test-"));
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
  const tool = makeAddManyTool(db);

  db.prepare(
    "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
  ).run("proj1", "Project One", dir, "2026-01-01T00:00:00.000Z");

  return { db, tool, dir };
}

function seedTickets(db: Database.Database, ids: string[]) {
  for (const id of ids) {
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, "proj1", "existing", "", "open", "2026-01-01T00:00:00.000Z");
  }
}

function ticketCount(db: Database.Database): number {
  return (
    db.prepare("SELECT COUNT(*) as n FROM tickets WHERE project_id = ?").get("proj1") as {
      n: number;
    }
  ).n;
}

describe("tickets.add_many parseArgs", () => {
  it("empty tickets array → throws McpError", () => {
    const tool = makeTool();
    expect(() => tool.parseArgs({ tickets: [] })).toThrow(McpError);
    expect(() => tool.parseArgs({ tickets: [] })).toThrow("non-empty array");
  });

  it("missing tickets → throws McpError", () => {
    const tool = makeTool();
    expect(() => tool.parseArgs({ project: "proj1" })).toThrow(McpError);
    expect(() => tool.parseArgs({ project: "proj1" })).toThrow("non-empty array");
  });

  it("non-object args → throws McpError", () => {
    const tool = makeTool();
    expect(() => tool.parseArgs(null)).toThrow(McpError);
    expect(() => tool.parseArgs(42)).toThrow(McpError);
  });

  it("blank title at index 1 → throws naming the index", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({ tickets: [{ title: "A" }, { title: "   " }] }),
    ).toThrow("tickets[1].title");
  });

  it("missing title at index 0 → throws naming the index", () => {
    const tool = makeTool();
    expect(() => tool.parseArgs({ tickets: [{ description: "no title" }] })).toThrow(
      "tickets[0].title",
    );
  });

  it("bad status enum → throws naming index + allowed values", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({ tickets: [{ title: "A", status: "nope" }] }),
    ).toThrow("tickets[0].status");
    expect(() =>
      tool.parseArgs({ tickets: [{ title: "A", status: "nope" }] }),
    ).toThrow("in_progress");
  });

  it("bad type enum → throws naming index + allowed values", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({ tickets: [{ title: "A" }, { title: "B", type: "nope" }] }),
    ).toThrow("tickets[1].type");
    expect(() =>
      tool.parseArgs({ tickets: [{ title: "A" }, { title: "B", type: "nope" }] }),
    ).toThrow("umbrella");
  });

  it("bad priority enum → throws naming index + allowed values", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({ tickets: [{ title: "A", priority: "P9" }] }),
    ).toThrow("tickets[0].priority");
    expect(() =>
      tool.parseArgs({ tickets: [{ title: "A", priority: "P9" }] }),
    ).toThrow("P0");
  });

  it("null priority is allowed", () => {
    const tool = makeTool();
    const parsed = tool.parseArgs({ tickets: [{ title: "A", priority: null }] });
    expect(parsed.tickets[0]!.priority).toBeUndefined();
  });

  it("tags not an array → throws naming the index", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({ tickets: [{ title: "A", tags: "nope" }] }),
    ).toThrow("tickets[0].tags");
  });

  it("tags containing a non-string → throws naming the index", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({ tickets: [{ title: "A", tags: ["ok", 42] }] }),
    ).toThrow("tickets[0].tags");
  });

  it("non-string id → throws naming the index", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({ tickets: [{ title: "A", id: 7 }] }),
    ).toThrow("tickets[0].id");
  });

  it("non-string parent_id → throws naming the index", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({ tickets: [{ title: "A", parent_id: 7 }] }),
    ).toThrow("tickets[0].parent_id");
  });

  it("duplicate explicit id → throws naming the id and both positions", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({
        tickets: [
          { id: "T1", title: "A" },
          { id: "T1", title: "B" },
        ],
      }),
    ).toThrow("Duplicate ticket id 'T1' at positions 0 and 1.");
  });

  it("relations not an array → throws", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({ tickets: [{ title: "A" }], relations: "nope" }),
    ).toThrow("relations must be an array");
  });

  it("relation with bad kind → throws from parseArgs", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({
        tickets: [{ id: "T1", title: "A" }, { id: "T2", title: "B" }],
        relations: [{ from: "T1", to: "T2", kind: "invented" }],
      }),
    ).toThrow("relations[0].kind");
  });

  it("relation with blank from → throws naming the index", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({
        tickets: [{ title: "A" }],
        relations: [{ from: "", to: "T2", kind: "blocks" }],
      }),
    ).toThrow("relations[0].from");
  });

  it("relation note must be string or null", () => {
    const tool = makeTool();
    expect(() =>
      tool.parseArgs({
        tickets: [{ id: "T1", title: "A" }, { id: "T2", title: "B" }],
        relations: [{ from: "T1", to: "T2", kind: "blocks", note: 42 }],
      }),
    ).toThrow("relations[0].note");
  });

  it("valid mixed input → parses clean and returns typed AddManyArgs", () => {
    const tool = makeTool();
    const parsed = tool.parseArgs({
      project: "proj1",
      tickets: [
        {
          id: "T1",
          title: "Explicit one",
          description: "desc",
          status: "in_progress",
          priority: "P1",
          type: "bug",
          epic: "Foundation",
          parent_id: "T0",
          effort: 3,
          created_by: "ed",
          tags: ["fts", "search"],
        },
        { title: "Auto one" },
      ],
      relations: [{ from: "T1", to: "T0", kind: "blocks", note: "needs T0" }],
    });

    expect(parsed.project).toBe("proj1");
    expect(parsed.tickets).toHaveLength(2);
    expect(parsed.tickets[0]!.id).toBe("T1");
    expect(parsed.tickets[0]!.title).toBe("Explicit one");
    expect(parsed.tickets[0]!.status).toBe("in_progress");
    expect(parsed.tickets[0]!.priority).toBe("P1");
    expect(parsed.tickets[0]!.effort).toBe(3);
    expect(parsed.tickets[0]!.tags).toEqual(["fts", "search"]);
    expect(parsed.tickets[1]!.id).toBeUndefined();
    expect(parsed.tickets[1]!.title).toBe("Auto one");
    expect(parsed.relations).toHaveLength(1);
    expect(parsed.relations![0]!.kind).toBe("blocks");
    expect(parsed.relations![0]!.note).toBe("needs T0");
  });

});

describe("tickets.add_many handle", () => {
  it("N inline tickets → created lists ids in input order, count === N, no full rows", async () => {
    const { db, tool } = setup();
    const result = await tool.handle(
      tool.parseArgs({
        project: "proj1",
        tickets: [
          { id: "A1", title: "Alpha", priority: "P1" },
          { id: "B2", title: "Beta", type: "bug", tags: ["x"] },
          { id: "C3", title: "Gamma" },
        ],
      }),
    );

    expect(result.created).toEqual(["A1", "B2", "C3"]);
    expect(result.count).toBe(3);
    expect(result).not.toHaveProperty("ticket");
    expect(result).not.toHaveProperty("tickets");
    expect(ticketCount(db)).toBe(3);
    db.close();
  });

  it("all ids omitted on a project seeded with T1..T4 → created === T5,T6,...", async () => {
    const { db, tool } = setup();
    seedTickets(db, ["T1", "T2", "T3", "T4"]);

    const result = await tool.handle(
      tool.parseArgs({
        project: "proj1",
        tickets: [{ title: "A" }, { title: "B" }, { title: "C" }],
      }),
    );

    expect(result.created).toEqual(["T5", "T6", "T7"]);
    expect(result.count).toBe(3);
    db.close();
  });

  it("mixed explicit + auto → explicit id preserved, autos skip a collision", async () => {
    const { db, tool } = setup();

    const result = await tool.handle(
      tool.parseArgs({
        project: "proj1",
        tickets: [{ title: "A" }, { id: "T9", title: "B" }, { title: "C" }],
      }),
    );

    // Explicit T9 untouched; autos are T1, T2 (T9 is not in the auto sequence yet).
    expect(result.created).toEqual(["T1", "T9", "T2"]);
    expect(result.count).toBe(3);

    const rows = db
      .prepare("SELECT id FROM tickets WHERE project_id = ? ORDER BY id")
      .all("proj1") as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(["T1", "T2", "T9"]);
    db.close();
  });

  it("autos skip an explicit id that would collide", async () => {
    const { db, tool } = setup();
    seedTickets(db, ["T1"]);

    // Next auto would be T2; an explicit T2 in the same batch forces autos past it.
    const result = await tool.handle(
      tool.parseArgs({
        project: "proj1",
        tickets: [{ id: "T2", title: "explicit" }, { title: "auto" }],
      }),
    );

    expect(result.created).toEqual(["T2", "T3"]);
    db.close();
  });

  it("parent_id to an explicit sibling in the same call resolves", async () => {
    const { db, tool } = setup();

    await tool.handle(
      tool.parseArgs({
        project: "proj1",
        tickets: [
          { id: "P1", title: "parent" },
          { id: "C1", title: "child", parent_id: "P1" },
        ],
      }),
    );

    const child = db
      .prepare("SELECT parent_id FROM tickets WHERE project_id = ? AND id = ?")
      .get("proj1", "C1") as { parent_id: string | null };
    expect(child.parent_id).toBe("P1");
    db.close();
  });

  it("parent_id to a ticket absent from batch and DB → clean McpError, nothing inserted", async () => {
    const { db, tool } = setup();

    await expect(
      tool.handle(
        tool.parseArgs({
          project: "proj1",
          tickets: [{ id: "C1", title: "child", parent_id: "NOPE" }],
        }),
      ),
    ).rejects.toThrow(McpError);
    await expect(
      tool.handle(
        tool.parseArgs({
          project: "proj1",
          tickets: [{ id: "C1", title: "child", parent_id: "NOPE" }],
        }),
      ),
    ).rejects.toThrow("NOPE");

    // Fails before insert — no tickets created.
    expect(ticketCount(db)).toBe(0);
    db.close();
  });

  it("parent_id naming an auto-id'd sibling by guessed id → clean McpError, not raw SqliteError", async () => {
    const { db, tool } = setup();

    // Documented limit: an auto-id'd sibling cannot be referenced as a parent_id —
    // its real id isn't known at author time. On an empty project these two id-less
    // tickets resolve to T1, T2, so the child's guessed "T9" matches neither the
    // batch nor the DB and must surface a clean McpError (not a raw SqliteError).
    await expect(
      tool.handle(
        tool.parseArgs({
          project: "proj1",
          tickets: [{ title: "parent" }, { title: "child", parent_id: "T9" }],
        }),
      ),
    ).rejects.toThrow(McpError);
    await expect(
      tool.handle(
        tool.parseArgs({
          project: "proj1",
          tickets: [{ title: "parent" }, { title: "child", parent_id: "T9" }],
        }),
      ),
    ).rejects.toThrow("parent_id 'T9'");

    expect(ticketCount(db)).toBe(0);
    db.close();
  });

  it("invalid ticket rolls back the whole batch (effort rejected by DB CHECK)", async () => {
    const { db, tool } = setup();

    await expect(
      tool.handle(
        tool.parseArgs({
          project: "proj1",
          tickets: [
            { id: "K1", title: "good" },
            { id: "K2", title: "bad", effort: 4 },
          ],
        }),
      ),
    ).rejects.toThrow(McpError);

    // Whole batch rolled back — no tickets created.
    expect(ticketCount(db)).toBe(0);
    db.close();
  });

  it("tags are normalised and deduped, one _created audit row per ticket", async () => {
    const { db, tool } = setup();

    await tool.handle(
      tool.parseArgs({
        project: "proj1",
        tickets: [{ id: "T1", title: "tagged", tags: ["A", "a", "B"] }],
      }),
    );

    const tags = db
      .prepare("SELECT tag FROM tags WHERE project_id = ? AND ticket_id = ? ORDER BY tag")
      .all("proj1", "T1") as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toEqual(["a", "b"]);

    const audit = db
      .prepare(
        "SELECT COUNT(*) as n FROM audit_log WHERE project_id = ? AND ticket_id = ? AND field = '_created'",
      )
      .get("proj1", "T1") as { n: number };
    expect(audit.n).toBe(1);
    db.close();
  });

  it("warnings key omitted when there are none", async () => {
    const { db, tool } = setup();

    const result = await tool.handle(
      tool.parseArgs({ project: "proj1", tickets: [{ id: "T1", title: "A" }] }),
    );

    expect(result).not.toHaveProperty("warnings");
    db.close();
  });

  it("warnings present when a dangling relation is skipped", async () => {
    const { db, tool } = setup();

    const result = await tool.handle(
      tool.parseArgs({
        project: "proj1",
        tickets: [{ id: "T1", title: "A" }],
        relations: [{ from: "T1", to: "GHOST", kind: "blocks" }],
      }),
    );

    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes("GHOST"))).toBe(true);

    const relCount = (
      db.prepare("SELECT COUNT(*) as n FROM relations WHERE project_id = ?").get("proj1") as {
        n: number;
      }
    ).n;
    expect(relCount).toBe(0);
    db.close();
  });
});
