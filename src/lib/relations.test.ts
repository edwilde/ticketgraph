import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { ticketExists, isKnownKind, KNOWN_RELATION_KINDS } from "./relations.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-relations-lib-test-"));
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
  db.prepare(
    `INSERT INTO tickets (id, project_id, title, description, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("T1", "proj1", "First", "", "open", "2026-01-01T00:00:00.000Z");
  return { db };
}

describe("isKnownKind", () => {
  it("returns true for all canonical kinds", () => {
    for (const kind of KNOWN_RELATION_KINDS) {
      expect(isKnownKind(kind)).toBe(true);
    }
  });

  it("returns false for unknown kinds", () => {
    expect(isKnownKind("custom_kind")).toBe(false);
    expect(isKnownKind("")).toBe(false);
  });
});

describe("ticketExists", () => {
  it("returns true for existing ticket", () => {
    const { db } = setup();
    expect(ticketExists(db, "proj1", "T1")).toBe(true);
    db.close();
  });

  it("returns false for non-existent ticket", () => {
    const { db } = setup();
    expect(ticketExists(db, "proj1", "T99")).toBe(false);
    db.close();
  });

  it("returns false for ticket in wrong project", () => {
    const { db } = setup();
    expect(ticketExists(db, "other-project", "T1")).toBe(false);
    db.close();
  });
});
