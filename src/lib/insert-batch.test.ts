import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { insertBatch } from "./insert-batch.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-insert-batch-test-"));
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
  ).run("demo", "demo CLI", dir, "2026-01-01T00:00:00.000Z");

  return { db, dir };
}

describe("insertBatch", () => {
  it("created lists inserted ids in input order", () => {
    const { db } = setup();
    const result = insertBatch(db, {
      projectId: "demo",
      tickets: [
        { id: "T2", title: "Second" },
        { id: "T1", title: "First" },
        { id: "T3", title: "Third" },
      ],
    });
    expect(result.created).toEqual(["T2", "T1", "T3"]);
    expect(result.imported).toBe(true);
    expect(result.counts.tickets).toBe(3);
    db.close();
  });

  it("duplicate without force aborts with McpError", () => {
    const { db } = setup();
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("T1", "demo", "existing", "", "open", "2026-01-01T00:00:00.000Z");

    expect(() =>
      insertBatch(db, {
        projectId: "demo",
        tickets: [{ id: "T1", title: "Replacement" }],
      }),
    ).toThrow(McpError);
    db.close();
  });

  it("duplicate with force overwrites cleanly", () => {
    const { db } = setup();
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("T1", "demo", "original title", "", "open", "2026-01-01T00:00:00.000Z");

    const result = insertBatch(db, {
      projectId: "demo",
      tickets: [{ id: "T1", title: "Replacement title" }],
      force: true,
    });
    expect(result.imported).toBe(true);
    expect(result.created).toEqual(["T1"]);

    const ticket = db
      .prepare("SELECT title FROM tickets WHERE project_id = ? AND id = ?")
      .get("demo", "T1") as { title: string };
    expect(ticket.title).toBe("Replacement title");
    db.close();
  });

  it("dangling relation skipped with warning containing missing id", () => {
    const { db } = setup();
    const result = insertBatch(db, {
      projectId: "demo",
      tickets: [{ id: "T1", title: "Only ticket" }],
      relations: [{ from: "T1", to: "T999", kind: "blocks" }],
    });

    expect(result.imported).toBe(true);
    expect(result.warnings.some((w) => w.includes("T999"))).toBe(true);

    const n = (
      db
        .prepare("SELECT COUNT(*) as n FROM relations WHERE project_id = ?")
        .get("demo") as { n: number }
    ).n;
    expect(n).toBe(0);
    expect(result.counts.relations).toBe(0);
    db.close();
  });

  it("forward parent reference resolves (child listed before parent)", () => {
    const { db } = setup();
    insertBatch(db, {
      projectId: "demo",
      tickets: [
        { id: "T2", title: "Child", parent_id: "T1" },
        { id: "T1", title: "Parent" },
      ],
    });

    const child = db
      .prepare("SELECT parent_id FROM tickets WHERE project_id = ? AND id = ?")
      .get("demo", "T2") as { parent_id: string | null };
    expect(child.parent_id).toBe("T1");
    db.close();
  });

  it("_created audit row back-dated to ticket created_at", () => {
    const { db } = setup();
    insertBatch(db, {
      projectId: "demo",
      tickets: [{ id: "T1", title: "X", created_at: "2025-06-01T10:00:00.000Z" }],
    });

    const audit = db
      .prepare(
        "SELECT changed_at FROM audit_log WHERE project_id = ? AND ticket_id = ? AND field = '_created'",
      )
      .get("demo", "T1") as { changed_at: string } | undefined;

    expect(audit).toBeDefined();
    expect(audit!.changed_at).toBe("2025-06-01T10:00:00.000Z");
    db.close();
  });

  it("counts.relations counts only newly-inserted relations (precise count)", () => {
    const { db } = setup();
    // Pre-insert two tickets and two relations via raw SQL.
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("A1", "demo", "A1", "", "open", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("A2", "demo", "A2", "", "open", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO relations (project_id, from_id, to_id, kind, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("demo", "A1", "A2", "blocks", null, "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO relations (project_id, from_id, to_id, kind, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("demo", "A2", "A1", "relates_to", null, "2026-01-01T00:00:00.000Z");

    const result = insertBatch(db, {
      projectId: "demo",
      tickets: [{ id: "T1", title: "New" }],
      relations: [{ from: "T1", to: "A1", kind: "blocks" }],
    });

    expect(result.counts.relations).toBe(1);

    const total = (
      db
        .prepare("SELECT COUNT(*) as n FROM relations WHERE project_id = ?")
        .get("demo") as { n: number }
    ).n;
    expect(total).toBe(3);
    db.close();
  });

  it("dryRun returns shape and leaves DB unchanged", () => {
    const { db } = setup();
    const result = insertBatch(db, {
      projectId: "demo",
      tickets: [
        { id: "T1", title: "First", tags: ["a", "b"] },
        { id: "T2", title: "Second" },
      ],
      relations: [{ from: "T1", to: "T2", kind: "blocks" }],
      dryRun: true,
    });

    expect(result.dry_run).toBe(true);
    expect(result.imported).toBeUndefined();
    expect(result.created).toEqual([]);
    expect(result.counts.tickets).toBe(2);
    expect(result.counts.relations).toBe(1);
    expect(result.counts.tags).toBe(2);
    expect(Array.isArray(result.warnings)).toBe(true);

    const n = (
      db.prepare("SELECT COUNT(*) as n FROM tickets WHERE project_id = ?").get("demo") as {
        n: number;
      }
    ).n;
    expect(n).toBe(0);
    db.close();
  });
});
