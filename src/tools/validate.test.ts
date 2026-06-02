import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { makeAddTool } from "./add.js";
import { makeUpdateTool } from "./update.js";
import { makeValidateTool } from "./validate.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-validate-test-"));
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
  const tool = makeValidateTool(db);

  async function addTicket(title = "Test ticket") {
    const r = await addTool.handle(addTool.parseArgs({ project: "proj1", title, full: true }));
    if (!("ticket" in r)) throw new Error("expected full add result");
    return r.ticket;
  }

  async function updateTicket(id: string, patch: Record<string, unknown>) {
    return updateTool.handle(updateTool.parseArgs({ project: "proj1", id, patch }));
  }

  async function validate() {
    return tool.handle(tool.parseArgs({ project: "proj1" }));
  }

  return { db, addTicket, updateTicket, validate };
}

describe("tickets.validate", () => {
  it("clean project → ok: true, issues: []", async () => {
    const { addTicket, validate } = setup();
    await addTicket("Clean ticket");
    const result = await validate();
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("closed_at set + status open → error issue, ok: false", async () => {
    const { db, validate } = setup();
    // Insert a ticket with closed_at but non-terminal status directly.
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, status, type, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("T1", "proj1", "Bad ticket", "open", "task", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");

    const result = await validate();
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.kind === "closed_without_terminal_status");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
    expect(issue!.ticket_id).toBe("T1");
    db.close();
  });

  it("done + closed_at null → info issue, ok: true", async () => {
    const { db, validate } = setup();
    // Insert a done ticket without closed_at (legal post-import scenario).
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, status, type, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run("T1", "proj1", "Imported done", "done", "task", "2026-01-01T00:00:00.000Z");

    const result = await validate();
    expect(result.ok).toBe(true);
    const issue = result.issues.find((i) => i.kind === "terminal_without_closed_at");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("info");
    expect(issue!.ticket_id).toBe("T1");
    db.close();
  });

  it("orphan parent_id → error issue (fabricated via PRAGMA foreign_keys=OFF)", async () => {
    // FK normally prevents orphan parent_id via ON DELETE SET NULL.
    // We fabricate the corrupt state by disabling FKs before inserting.
    const { db, validate } = setup();

    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, status, type, created_at, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("ORPHAN", "proj1", "Orphan", "open", "task", "2026-01-01T00:00:00.000Z", "GHOST");
    db.pragma("foreign_keys = ON");

    const result = await validate();
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.kind === "orphan_parent");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
    expect(issue!.ticket_id).toBe("ORPHAN");
    db.close();
  });

  it("dangling relation (from_id missing) → error issue (fabricated via PRAGMA foreign_keys=OFF)", async () => {
    // FK ON DELETE CASCADE normally removes relations when a ticket is deleted.
    // We fabricate by disabling FKs and inserting a relation with a non-existent from_id.
    const { db, addTicket, validate } = setup();
    const t = await addTicket("Real ticket");

    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO relations (project_id, from_id, to_id, kind, note, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run("proj1", "GHOST", t.id, "blocks", "2026-01-01T00:00:00.000Z");
    db.pragma("foreign_keys = ON");

    const result = await validate();
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.kind === "dangling_relation");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
    db.close();
  });

  it("dangling relation (to_id missing) → error issue (fabricated via PRAGMA foreign_keys=OFF)", async () => {
    const { db, addTicket, validate } = setup();
    const t = await addTicket("Real ticket");

    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO relations (project_id, from_id, to_id, kind, note, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run("proj1", t.id, "GHOST", "blocks", "2026-01-01T00:00:00.000Z");
    db.pragma("foreign_keys = ON");

    const result = await validate();
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.kind === "dangling_relation");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
    db.close();
  });

  it("multiple issues can coexist", async () => {
    const { db, validate } = setup();

    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, status, type, created_at, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("ORPHAN", "proj1", "Orphan", "open", "task", "2026-01-01T00:00:00.000Z", "GHOST");
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, status, type, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("BAD", "proj1", "Bad closed", "open", "task", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    db.pragma("foreign_keys = ON");

    const result = await validate();
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
    db.close();
  });

  it("token budget: result JSON < 500*4 bytes", async () => {
    const { addTicket, validate, db } = setup();
    await addTicket("Clean");
    const result = await validate();
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(500 * 4);
    db.close();
  });
});
