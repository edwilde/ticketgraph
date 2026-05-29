import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "./db.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-schema-test-"));
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
  const dir = makeTmpDir();
  return openDb({ path: join(dir, "test.db") }).db;
}

// ── Task 2: schema introspection ─────────────────────────────────────────────

describe("schema introspection", () => {
  it("all expected tables, indexes, and triggers exist (exact set)", () => {
    const db = openFreshDb();

    const rows = db
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY type, name",
      )
      .all() as Array<{ type: string; name: string }>;
    db.close();

    const byType = (t: string) =>
      new Set(rows.filter((r) => r.type === t).map((r) => r.name));

    const tables = byType("table");
    const indexes = byType("index");
    const triggers = byType("trigger");

    // Tables — filter to the 6 spec-defined tables only.
    // FTS5 creates shadow tables (tickets_fts_config, _content, _data, _docsize, _idx)
    // and AUTOINCREMENT creates sqlite_sequence; exclude those from the assertion.
    const specTables = new Set(["projects", "tickets", "relations", "tags", "tickets_fts", "audit_log"]);
    const actualSpecTables = new Set([...tables].filter((n) => specTables.has(n)));
    expect(actualSpecTables).toEqual(specTables);

    // All 10 indexes from spec §5 must be present.
    // SQLite also creates implicit sqlite_autoindex_* entries for PRIMARY KEY/UNIQUE
    // constraints; we assert inclusion of the spec indexes, not strict set equality.
    const specIndexes = [
      "idx_tickets_status",
      "idx_tickets_priority",
      "idx_tickets_epic",
      "idx_tickets_type",
      "idx_tickets_parent",
      "idx_relations_to",
      "idx_relations_from",
      "idx_tags_tag",
      "idx_audit_changed_at",
      "idx_audit_ticket",
    ];
    for (const idx of specIndexes) {
      expect(indexes, `expected index ${idx} to exist`).toContain(idx);
    }

    // All 5 triggers from spec §5
    expect(triggers).toEqual(
      new Set([
        "tickets_fts_ai",
        "tickets_fts_ad",
        "tickets_fts_au",
        "tickets_closed_at_set",
        "tickets_closed_at_clear",
      ]),
    );
  });
});

// ── Task 3: round-trip + FTS sync ────────────────────────────────────────────

describe("FTS sync", () => {
  it("insert → search → update title → search → delete → search", () => {
    const db = openFreshDb();

    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("proj1", "Project One", "/tmp/proj1", "2026-01-01T00:00:00.000Z");

    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("T1", "proj1", "alpha", "the search index must follow", "open", "2026-01-01T00:00:00.000Z");

    // Insert: FTS must contain the ticket
    const afterInsert = db
      .prepare("SELECT ticket_id FROM tickets_fts WHERE tickets_fts MATCH 'alpha'")
      .all() as Array<{ ticket_id: string }>;
    expect(afterInsert).toHaveLength(1);
    expect(afterInsert[0]?.ticket_id).toBe("T1");

    // Update title: FTS must reflect the change
    db.prepare("UPDATE tickets SET title = ? WHERE project_id = ? AND id = ?").run(
      "beta",
      "proj1",
      "T1",
    );

    const afterUpdateBeta = db
      .prepare("SELECT ticket_id FROM tickets_fts WHERE tickets_fts MATCH 'beta'")
      .all() as Array<{ ticket_id: string }>;
    expect(afterUpdateBeta).toHaveLength(1);
    expect(afterUpdateBeta[0]?.ticket_id).toBe("T1");

    const afterUpdateAlpha = db
      .prepare("SELECT ticket_id FROM tickets_fts WHERE tickets_fts MATCH 'alpha'")
      .all();
    expect(afterUpdateAlpha).toHaveLength(0);

    // Delete: FTS must no longer contain the ticket
    db.prepare("DELETE FROM tickets WHERE project_id = ? AND id = ?").run("proj1", "T1");

    const afterDelete = db
      .prepare("SELECT ticket_id FROM tickets_fts WHERE tickets_fts MATCH 'beta'")
      .all();
    expect(afterDelete).toHaveLength(0);

    db.close();
  });
});

// ── Task 4: closed_at transition tests ───────────────────────────────────────

describe("closed_at triggers", () => {
  function insertProject(db: ReturnType<typeof openFreshDb>, id = "proj1") {
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, "Project", `/tmp/${id}`, "2026-01-01T00:00:00.000Z");
  }

  function insertTicket(
    db: ReturnType<typeof openFreshDb>,
    id: string,
    status: string,
    projectId = "proj1",
  ) {
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, "A ticket", "", status, "2026-01-01T00:00:00.000Z");
  }

  function getClosedAt(
    db: ReturnType<typeof openFreshDb>,
    id: string,
    projectId = "proj1",
  ): string | null {
    const row = db
      .prepare("SELECT closed_at FROM tickets WHERE project_id = ? AND id = ?")
      .get(projectId, id) as { closed_at: string | null } | undefined;
    return row?.closed_at ?? null;
  }

  it("case 1: open ticket starts with closed_at = NULL", () => {
    const db = openFreshDb();
    insertProject(db);
    insertTicket(db, "T1", "open");
    expect(getClosedAt(db, "T1")).toBeNull();
    db.close();
  });

  it("case 2: transition open → done sets closed_at", () => {
    const db = openFreshDb();
    insertProject(db);
    insertTicket(db, "T1", "open");
    db.prepare("UPDATE tickets SET status = ? WHERE project_id = ? AND id = ?").run(
      "done",
      "proj1",
      "T1",
    );
    const closedAt = getClosedAt(db, "T1");
    expect(closedAt).not.toBeNull();
    expect(closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    db.close();
  });

  it("case 3: transition done → open clears closed_at", () => {
    const db = openFreshDb();
    insertProject(db);
    insertTicket(db, "T1", "open");
    db.prepare("UPDATE tickets SET status = ? WHERE project_id = ? AND id = ?").run(
      "done",
      "proj1",
      "T1",
    );
    expect(getClosedAt(db, "T1")).not.toBeNull();

    db.prepare("UPDATE tickets SET status = ? WHERE project_id = ? AND id = ?").run(
      "open",
      "proj1",
      "T1",
    );
    expect(getClosedAt(db, "T1")).toBeNull();
    db.close();
  });

  it("case 4: INSERT with status=done does NOT set closed_at (trigger only fires on UPDATE)", () => {
    // This is intentional per spec §5: closed_at is a status-transition concept.
    // The INSERT path does not fire the trigger; application code handles import-time closed_at.
    const db = openFreshDb();
    insertProject(db);
    insertTicket(db, "T1", "done");
    expect(getClosedAt(db, "T1")).toBeNull();
    db.close();
  });

  it("case 5: done → deferred does NOT reset closed_at (both are terminal states)", () => {
    const db = openFreshDb();
    insertProject(db);
    insertTicket(db, "T1", "open");

    // Transition into done — sets closed_at
    db.prepare("UPDATE tickets SET status = ? WHERE project_id = ? AND id = ?").run(
      "done",
      "proj1",
      "T1",
    );
    const closedAtAfterDone = getClosedAt(db, "T1");
    expect(closedAtAfterDone).not.toBeNull();

    // Transition done → deferred — WHEN clause guards: old NOT IN ('done','deferred') so this is a no-op
    db.prepare("UPDATE tickets SET status = ? WHERE project_id = ? AND id = ?").run(
      "deferred",
      "proj1",
      "T1",
    );
    const closedAtAfterDeferred = getClosedAt(db, "T1");
    // closed_at is preserved from the done transition; the set-trigger did not re-fire
    expect(closedAtAfterDeferred).toBe(closedAtAfterDone);

    // Transition deferred → open — clears closed_at
    db.prepare("UPDATE tickets SET status = ? WHERE project_id = ? AND id = ?").run(
      "open",
      "proj1",
      "T1",
    );
    expect(getClosedAt(db, "T1")).toBeNull();

    db.close();
  });
});

// ── Task 5: relations cascade ────────────────────────────────────────────────

describe("relations ON DELETE CASCADE", () => {
  it("deleting a ticket cascades to its relation rows", () => {
    const db = openFreshDb();

    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("proj1", "Project", "/tmp/proj1", "2026-01-01T00:00:00.000Z");

    const insertTicket = db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertTicket.run("T1", "proj1", "Blocker", "", "open", "2026-01-01T00:00:00.000Z");
    insertTicket.run("T2", "proj1", "Blocked", "", "open", "2026-01-01T00:00:00.000Z");

    db.prepare(
      `INSERT INTO relations (project_id, from_id, to_id, kind, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("proj1", "T1", "T2", "blocks", "2026-01-01T00:00:00.000Z");

    // Confirm relation exists
    const before = db
      .prepare("SELECT * FROM relations WHERE project_id = ? AND from_id = ?")
      .all("proj1", "T1");
    expect(before).toHaveLength(1);

    // Delete T1 — cascade must remove the relation
    db.prepare("DELETE FROM tickets WHERE project_id = ? AND id = ?").run("proj1", "T1");

    const after = db
      .prepare("SELECT * FROM relations WHERE project_id = ?")
      .all("proj1");
    expect(after).toHaveLength(0);

    db.close();
  });
});

// ── Task 6: tags cascade ─────────────────────────────────────────────────────

describe("tags ON DELETE CASCADE", () => {
  it("deleting a ticket cascades to its tag rows", () => {
    const db = openFreshDb();

    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("proj1", "Project", "/tmp/proj1", "2026-01-01T00:00:00.000Z");

    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("T1", "proj1", "Tagged ticket", "", "open", "2026-01-01T00:00:00.000Z");

    db.prepare(
      "INSERT INTO tags (project_id, ticket_id, tag) VALUES (?, ?, ?)",
    ).run("proj1", "T1", "fts");

    // Confirm tag exists
    const before = db
      .prepare("SELECT * FROM tags WHERE project_id = ? AND ticket_id = ?")
      .all("proj1", "T1");
    expect(before).toHaveLength(1);

    // Delete ticket — cascade must remove the tag
    db.prepare("DELETE FROM tickets WHERE project_id = ? AND id = ?").run("proj1", "T1");

    const after = db
      .prepare("SELECT * FROM tags WHERE project_id = ?")
      .all("proj1");
    expect(after).toHaveLength(0);

    db.close();
  });
});

// ── Task 7: effort CHECK constraint ─────────────────────────────────────────

describe("effort CHECK constraint", () => {
  function insertProject(db: ReturnType<typeof openFreshDb>) {
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("proj1", "Project", "/tmp/proj1", "2026-01-01T00:00:00.000Z");
  }

  function insertTicketWithEffort(
    db: ReturnType<typeof openFreshDb>,
    id: string,
    effort: number | null,
  ) {
    db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, effort, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, "proj1", "A ticket", "", "open", effort, "2026-01-01T00:00:00.000Z");
  }

  it("effort = 1 is accepted (Fibonacci minimum)", () => {
    const db = openFreshDb();
    insertProject(db);
    expect(() => insertTicketWithEffort(db, "T1", 1)).not.toThrow();
    db.close();
  });

  it("effort = 5 is accepted", () => {
    const db = openFreshDb();
    insertProject(db);
    expect(() => insertTicketWithEffort(db, "T1", 5)).not.toThrow();
    db.close();
  });

  it("effort = NULL is accepted", () => {
    const db = openFreshDb();
    insertProject(db);
    expect(() => insertTicketWithEffort(db, "T1", null)).not.toThrow();
    db.close();
  });

  it("effort = 13 is accepted", () => {
    const db = openFreshDb();
    insertProject(db);
    expect(() => insertTicketWithEffort(db, "T1", 13)).not.toThrow();
    db.close();
  });

  it("effort = 4 is rejected (not in Fibonacci set)", () => {
    const db = openFreshDb();
    insertProject(db);
    expect(() => insertTicketWithEffort(db, "T1", 4)).toThrow(/CHECK constraint failed/);
    db.close();
  });
});
