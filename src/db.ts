import Database from "better-sqlite3";
import { mkdirSync, readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import * as logger from "./logger.js";

export interface OpenDbOptions {
  /** Explicit path to the SQLite file. Overrides TICKETGRAPH_DB_PATH env var. */
  path?: string;
  /** Open in read-only mode. Migrations will NOT run; throws if DB is stale. */
  readonly?: boolean;
  /**
   * Override the migrations directory.
   * @internal For tests only — not part of the public API.
   */
  _migrationsDir?: string;
}

export interface OpenDbResult {
  db: Database.Database;
  dbPath: string;
}

const DEFAULT_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

/**
 * Open (or create) the ticketgraph SQLite database, apply pending migrations,
 * and return the handle plus the resolved path.
 * PRAGMAs are applied in the required order before any migration runs.
 */
export function openDb(options: OpenDbOptions = {}): OpenDbResult {
  const dbPath =
    options.path ??
    process.env["TICKETGRAPH_DB_PATH"] ??
    join(os.homedir(), ".claude", "tickets.db");

  const migrationsDir = options._migrationsDir ?? DEFAULT_MIGRATIONS_DIR;

  // Ensure the parent directory exists (common first-run failure mode).
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { readonly: options.readonly ?? false });

  // PRAGMA order matters: WAL → foreign_keys → synchronous, BEFORE migrations.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  if (options.readonly) {
    // In read-only mode, refuse to serve a stale database.
    const currentVersion = db.pragma("user_version", { simple: true }) as number;
    const pendingCount = countPendingMigrations(migrationsDir, currentVersion);
    if (pendingCount > 0) {
      db.close();
      throw new Error(
        `DB at ${dbPath} is stale (user_version=${currentVersion}, ${pendingCount} pending migrations). Run in write mode to migrate.`,
      );
    }
    if (!options._migrationsDir) {
      assertSchemaIntact(db, dbPath);
    }
    return { db, dbPath };
  }

  applyMigrations(db, migrationsDir);
  // Only guard against version/schema mismatch when using the real migrations dir.
  // A custom _migrationsDir is a test-only override with toy schemas that don't include 'projects'.
  if (!options._migrationsDir) {
    assertSchemaIntact(db, dbPath);
  }

  return { db, dbPath };
}

/**
 * Guard: if the DB reports user_version >= 1 but is missing the 'projects' table,
 * close the handle and throw a clear, actionable error.
 * A fresh version-0 DB legitimately has no tables before migration; this guard
 * only fires when the version/schema are out of sync (half-init, interrupted migration, etc.).
 */
function assertSchemaIntact(db: Database.Database, dbPath: string): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version >= 1) {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
      .get();
    if (!row) {
      db.close();
      throw new Error(
        `Database at ${dbPath} reports schema version ${version} but is missing the expected 'projects' table. ` +
          `This usually means it was created by a pre-release build or a migration was interrupted. ` +
          `Back it up if it holds data, delete it, and restart to re-initialise.`,
      );
    }
  }
}

function listMigrationFiles(migrationsDir: string): { name: string; n: number }[] {
  let entries: string[];
  try {
    entries = readdirSync(migrationsDir);
  } catch (err) {
    throw new Error(`migrations dir not found: ${migrationsDir} (${String(err)})`);
  }

  return entries
    .filter((f) => f.endsWith(".sql"))
    .map((name) => ({ name, n: parseInt(name.slice(0, 3), 10) }))
    .filter(({ n }) => !isNaN(n))
    .sort((a, b) => a.n - b.n);
}

function countPendingMigrations(migrationsDir: string, currentVersion: number): number {
  const files = listMigrationFiles(migrationsDir);
  return files.filter(({ n }) => n > currentVersion).length;
}

function applyMigrations(db: Database.Database, migrationsDir: string): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  const files = listMigrationFiles(migrationsDir);
  const pending = files.filter(({ n }) => n > currentVersion);

  let applied = 0;

  for (const { name, n } of pending) {
    const sqlPath = join(migrationsDir, name);
    const sql = readFileSync(sqlPath, "utf-8").trim();

    const migrate = db.transaction(() => {
      if (sql.length > 0) {
        db.exec(sql);
      }
      // user_version bump is the last statement — half-applied files are impossible.
      db.pragma(`user_version = ${n}`);
    });

    try {
      migrate();
      applied++;
    } catch (err) {
      throw new Error(`migration ${name} failed: ${String(err)}`);
    }
  }

  const finalVersion = db.pragma("user_version", { simple: true }) as number;
  logger.info("migrations: applied " + applied + " (user_version=" + finalVersion + ")", {
    applied,
    version: finalVersion,
  });
}
