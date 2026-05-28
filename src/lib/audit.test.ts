import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { writeAudit } from "./audit.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-audit-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function openFreshDb() {
  return openDb({ path: join(makeTmpDir(), "test.db") }).db;
}

function seedProject(db: ReturnType<typeof openFreshDb>) {
  db.prepare(
    "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
  ).run("proj1", "Project One", "/tmp/proj1", "2026-01-01T00:00:00.000Z");
}

function seedTicket(db: ReturnType<typeof openFreshDb>, id = "T1") {
  db.prepare(
    `INSERT INTO tickets (id, project_id, title, description, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, "proj1", "A ticket", "", "open", "2026-01-01T00:00:00.000Z");
}

describe("writeAudit", () => {
  it("inserts a row and returns the row id", () => {
    const db = openFreshDb();
    seedProject(db);
    seedTicket(db);

    const rowId = writeAudit(db, {
      projectId: "proj1",
      ticketId: "T1",
      field: "_created",
      oldValue: null,
      newValue: "T1",
      changedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(rowId).toBeGreaterThan(0);
    db.close();
  });

  it("the inserted row is readable with correct fields", () => {
    const db = openFreshDb();
    seedProject(db);
    seedTicket(db);

    writeAudit(db, {
      projectId: "proj1",
      ticketId: "T1",
      field: "status",
      oldValue: "open",
      newValue: "done",
      changedAt: "2026-01-02T12:00:00.000Z",
    });

    const row = db
      .prepare("SELECT * FROM audit_log WHERE project_id = ? AND ticket_id = ?")
      .get("proj1", "T1") as Record<string, unknown>;

    expect(row["field"]).toBe("status");
    expect(row["old_value"]).toBe("open");
    expect(row["new_value"]).toBe("done");
    expect(row["changed_at"]).toBe("2026-01-02T12:00:00.000Z");
    db.close();
  });

  it("changedAt defaults to nowIso() when omitted", () => {
    const db = openFreshDb();
    seedProject(db);
    seedTicket(db);

    const before = new Date().toISOString();
    writeAudit(db, {
      projectId: "proj1",
      ticketId: "T1",
      field: "_created",
      oldValue: null,
      newValue: "T1",
    });
    const after = new Date().toISOString();

    const row = db
      .prepare("SELECT changed_at FROM audit_log WHERE project_id = ? AND ticket_id = ?")
      .get("proj1", "T1") as { changed_at: string };

    expect(row.changed_at >= before).toBe(true);
    expect(row.changed_at <= after).toBe(true);
    db.close();
  });

  it("null old_value and new_value are stored as NULL", () => {
    const db = openFreshDb();
    seedProject(db);
    seedTicket(db);

    writeAudit(db, {
      projectId: "proj1",
      ticketId: "T1",
      field: "_created",
      oldValue: null,
      newValue: null,
    });

    const row = db
      .prepare("SELECT old_value, new_value FROM audit_log WHERE project_id = ? AND ticket_id = ?")
      .get("proj1", "T1") as { old_value: null; new_value: null };

    expect(row.old_value).toBeNull();
    expect(row.new_value).toBeNull();
    db.close();
  });
});
