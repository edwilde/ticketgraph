import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { inferNextId, inferNextIds } from "./numbering.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-numbering-test-"));
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

function seedProject(db: ReturnType<typeof openFreshDb>, id = "proj1") {
  db.prepare(
    "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
  ).run(id, "Project", `/tmp/${id}`, "2026-01-01T00:00:00.000Z");
}

function addTicket(db: ReturnType<typeof openFreshDb>, id: string, projectId = "proj1") {
  db.prepare(
    `INSERT INTO tickets (id, project_id, title, description, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, "A ticket", "", "open", "2026-01-01T00:00:00.000Z");
}

describe("inferNextId", () => {
  it("returns T1 for an empty project", () => {
    const db = openFreshDb();
    seedProject(db);
    expect(inferNextId(db, "proj1")).toBe("T1");
    db.close();
  });

  it("returns T4 when T1, T2, T3 exist", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "T1");
    addTicket(db, "T2");
    addTicket(db, "T3");
    expect(inferNextId(db, "proj1")).toBe("T4");
    db.close();
  });

  it("uses the max id (not row count) when there are gaps", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "T1");
    addTicket(db, "T5");
    addTicket(db, "T10");
    expect(inferNextId(db, "proj1")).toBe("T11");
    db.close();
  });

  it("handles prefix with dash: BUG-1, BUG-2 → BUG-3", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "BUG-1");
    addTicket(db, "BUG-2");
    expect(inferNextId(db, "proj1")).toBe("BUG-3");
    db.close();
  });

  it("handles prefix without dash: FEAT1, FEAT2 → FEAT3", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "FEAT1");
    addTicket(db, "FEAT2");
    expect(inferNextId(db, "proj1")).toBe("FEAT3");
    db.close();
  });

  it("throws when multiple prefixes co-exist with no dominant (50/50)", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "BUG-1");
    addTicket(db, "FEAT-1");
    expect(() => inferNextId(db, "proj1")).toThrow(/multiple ID prefixes/);
    db.close();
  });

  it("returns dominant prefix when one is >50% of rows", () => {
    const db = openFreshDb();
    seedProject(db);
    // 3 T-prefix vs 1 BUG-prefix → T dominates
    addTicket(db, "T1");
    addTicket(db, "T2");
    addTicket(db, "T3");
    addTicket(db, "BUG-1");
    expect(inferNextId(db, "proj1")).toBe("T4");
    db.close();
  });
});

describe("inferNextIds", () => {
  it("returns T1, T2, T3 for an empty project with count 3", () => {
    const db = openFreshDb();
    seedProject(db);
    expect(inferNextIds(db, "proj1", 3, new Set())).toEqual(["T1", "T2", "T3"]);
    db.close();
  });

  it("returns T5, T6 when T1..T4 exist with count 2", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "T1");
    addTicket(db, "T2");
    addTicket(db, "T3");
    addTicket(db, "T4");
    expect(inferNextIds(db, "proj1", 2, new Set())).toEqual(["T5", "T6"]);
    db.close();
  });

  it("skips a reserved id: base T4, reserved={T5}, count 2 → T6, T7", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "T1");
    addTicket(db, "T2");
    addTicket(db, "T3");
    addTicket(db, "T4");
    expect(inferNextIds(db, "proj1", 2, new Set(["T5"]))).toEqual(["T6", "T7"]);
    db.close();
  });

  it("skips a non-contiguous reserved set: reserved={T5,T7}, base T4, count 3 → T6, T8, T9", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "T1");
    addTicket(db, "T2");
    addTicket(db, "T3");
    addTicket(db, "T4");
    expect(inferNextIds(db, "proj1", 3, new Set(["T5", "T7"]))).toEqual([
      "T6",
      "T8",
      "T9",
    ]);
    db.close();
  });

  it("succeeds (does not throw) on a dominant prefix: T1,T2,T3 + BUG1, count 2 → T4, T5", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "T1");
    addTicket(db, "T2");
    addTicket(db, "T3");
    addTicket(db, "BUG1");
    expect(inferNextIds(db, "proj1", 2, new Set())).toEqual(["T4", "T5"]);
    db.close();
  });

  it("handles a sole prefix SETUP-: SETUP-1, SETUP-2, count 2 → SETUP-3, SETUP-4", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "SETUP-1");
    addTicket(db, "SETUP-2");
    expect(inferNextIds(db, "proj1", 2, new Set())).toEqual([
      "SETUP-3",
      "SETUP-4",
    ]);
    db.close();
  });

  it("throws on multiple non-dominant prefixes (50/50) when count >= 1", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "T1");
    addTicket(db, "BUG1");
    expect(() => inferNextIds(db, "proj1", 1, new Set())).toThrow(
      /multiple ID prefixes/,
    );
    db.close();
  });

  it("returns [] for count 0 even on a multi-prefix project (no throw)", () => {
    const db = openFreshDb();
    seedProject(db);
    addTicket(db, "T1");
    addTicket(db, "BUG1");
    expect(inferNextIds(db, "proj1", 0, new Set())).toEqual([]);
    db.close();
  });
});
