import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openDb } from "./db.js";

// Every test creates its own temp dir; afterEach cleans it up.
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("openDb / migrations runner", () => {
  it("fresh DB is migrated to user_version=1", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "test.db");

    const { db } = openDb({ path: dbPath });
    const version = db.pragma("user_version", { simple: true }) as number;
    db.close();

    expect(version).toBe(1);
  });

  it("returns the resolved dbPath", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "test.db");

    const result = openDb({ path: dbPath });
    result.db.close();

    expect(result.dbPath).toBe(dbPath);
  });

  it("second openDb on the same path is idempotent (user_version stays 1, no error)", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "test.db");

    const { db: db1 } = openDb({ path: dbPath });
    db1.close();

    const { db: db2 } = openDb({ path: dbPath });
    const version = db2.pragma("user_version", { simple: true }) as number;
    db2.close();

    expect(version).toBe(1);
  });

  it("migrations run in lexical order regardless of readdir order", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "test.db");
    const migrationsDir = join(dir, "migrations");
    mkdirSync(migrationsDir);

    // Write 002 first, then 001, to stress ordering.
    writeFileSync(
      join(migrationsDir, "002_second.sql"),
      "CREATE TABLE second_table (id INTEGER PRIMARY KEY);",
    );
    writeFileSync(
      join(migrationsDir, "001_first.sql"),
      "CREATE TABLE first_table (id INTEGER PRIMARY KEY);",
    );

    const { db } = openDb({ path: dbPath, _migrationsDir: migrationsDir });
    const version = db.pragma("user_version", { simple: true }) as number;

    // Both tables should exist (001 ran before 002).
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    db.close();

    expect(version).toBe(2);
    expect(tables.map((t) => t.name)).toContain("first_table");
    expect(tables.map((t) => t.name)).toContain("second_table");
  });

  it("bad SQL in a migration rolls back: user_version unchanged, no side-effects", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "test.db");
    const migrationsDir = join(dir, "migrations");
    mkdirSync(migrationsDir);

    // Step 1: write only 001 and apply it so user_version lands at 1.
    writeFileSync(
      join(migrationsDir, "001_ok.sql"),
      "CREATE TABLE ok_table (id INTEGER PRIMARY KEY);",
    );
    const { db: db1 } = openDb({ path: dbPath, _migrationsDir: migrationsDir });
    db1.close();

    // Step 2: now add a bad 002 — it creates a table then hits invalid SQL.
    // The whole migration must roll back (table absent, user_version stays 1).
    writeFileSync(
      join(migrationsDir, "002_bad.sql"),
      "CREATE TABLE partial (id INTEGER PRIMARY KEY); NOT VALID SQL !!!;",
    );

    expect(() => openDb({ path: dbPath, _migrationsDir: migrationsDir })).toThrow(
      /migration 002_bad\.sql failed/,
    );

    // Verify user_version is still 1 and the partial table did not survive.
    const db2 = new Database(dbPath);
    const version = db2.pragma("user_version", { simple: true }) as number;
    const tables = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='partial'")
      .all();
    db2.close();

    expect(version).toBe(1);
    expect(tables).toHaveLength(0);
  });

  it("PRAGMAs are set correctly: WAL, foreign_keys=1, synchronous=NORMAL(1)", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "test.db");

    const { db } = openDb({ path: dbPath });
    const journalMode = db.pragma("journal_mode", { simple: true }) as string;
    const foreignKeys = db.pragma("foreign_keys", { simple: true }) as number;
    const synchronous = db.pragma("synchronous", { simple: true }) as number;
    db.close();

    expect(journalMode).toBe("wal");
    expect(foreignKeys).toBe(1);
    expect(synchronous).toBe(1); // 1 = NORMAL
  });

  it("TICKETGRAPH_DB_PATH env var is respected when no path option is given", () => {
    const dir = makeTmpDir();
    const envDbPath = join(dir, "env-test.db");

    const original = process.env["TICKETGRAPH_DB_PATH"];
    process.env["TICKETGRAPH_DB_PATH"] = envDbPath;

    try {
      const { db } = openDb(); // no path option
      db.close();
    } finally {
      if (original === undefined) {
        delete process.env["TICKETGRAPH_DB_PATH"];
      } else {
        process.env["TICKETGRAPH_DB_PATH"] = original;
      }
    }

    // The file must have been created at the env-var location.
    const db = new Database(envDbPath, { readonly: true });
    const version = db.pragma("user_version", { simple: true }) as number;
    db.close();

    expect(version).toBe(1);
  });
});
