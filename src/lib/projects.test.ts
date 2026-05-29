import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import {
  RESERVED_PROJECT_IDS,
  resolveProjectFromCwd,
  requireProject,
} from "./projects.js";
import { NO_ROOTS } from "./roots.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-projects-test-"));
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

describe("RESERVED_PROJECT_IDS", () => {
  it("contains 'all' and 'current'", () => {
    expect(RESERVED_PROJECT_IDS.has("all")).toBe(true);
    expect(RESERVED_PROJECT_IDS.has("current")).toBe(true);
  });
});

describe("resolveProjectFromCwd", () => {
  it("returns null when no projects registered", () => {
    const db = openFreshDb();
    const result = resolveProjectFromCwd(db, "/some/path");
    expect(result).toBeNull();
    db.close();
  });

  it("matches exact root_path", () => {
    const db = openFreshDb();
    const dir = makeTmpDir();
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("myproj", "My Project", dir, "2026-01-01T00:00:00.000Z");

    const result = resolveProjectFromCwd(db, dir);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("myproj");
    db.close();
  });

  it("matches subdirectory of root_path", () => {
    const db = openFreshDb();
    const dir = makeTmpDir();
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("myproj", "My Project", dir, "2026-01-01T00:00:00.000Z");

    const result = resolveProjectFromCwd(db, join(dir, "src", "lib"));
    expect(result).not.toBeNull();
    expect(result!.id).toBe("myproj");
    db.close();
  });

  it("picks longest prefix when two projects nest", () => {
    const db = openFreshDb();
    const parent = makeTmpDir();
    const child = mkdtempSync(join(parent, "child-"));
    tmpDirs.push(child);

    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("parent", "Parent", parent, "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("child", "Child", child, "2026-01-01T00:00:00.000Z");

    // cwd inside child → should resolve to child (longer prefix)
    const result = resolveProjectFromCwd(db, child);
    expect(result!.id).toBe("child");
    db.close();
  });

  it("returns null for unrelated path", () => {
    const db = openFreshDb();
    const dir = makeTmpDir();
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("myproj", "My Project", dir, "2026-01-01T00:00:00.000Z");

    const result = resolveProjectFromCwd(db, "/completely/different/path");
    expect(result).toBeNull();
    db.close();
  });
});

describe("requireProject", () => {
  it("explicit project resolves regardless of roots (NO_ROOTS)", async () => {
    const db = openFreshDb();
    const dir = makeTmpDir();
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("myproj", "My Project", dir, "2026-01-01T00:00:00.000Z");

    // Explicit project short-circuits resolution — roots/cwd are not consulted.
    const result = await requireProject(db, { project: "myproj" }, NO_ROOTS);
    expect(result.id).toBe("myproj");
    db.close();
  });

  it("resolves from client roots when roots provider returns a registered path", async () => {
    const db = openFreshDb();
    const dir = makeTmpDir();
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("rootproj", "Root Project", dir, "2026-01-01T00:00:00.000Z");

    // fake roots provider returns the registered dir; cwd would NOT match
    const fakeRoots = async () => [dir];
    const result = await requireProject(db, {}, fakeRoots);
    expect(result.id).toBe("rootproj");
    db.close();
  });

  it("falls back to cwd when roots are empty and cwd matches", async () => {
    const db = openFreshDb();
    // Register process.cwd() as the project root — this is the test environment
    const cwd = process.cwd();
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("cwdproj", "Cwd Project", cwd, "2026-01-01T00:00:00.000Z");

    const result = await requireProject(db, {}, NO_ROOTS);
    expect(result.id).toBe("cwdproj");
    db.close();
  });

  it("roots take precedence over cwd when both match different projects", async () => {
    const db = openFreshDb();
    const rootDir = makeTmpDir();
    const cwd = process.cwd();

    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("rootproj", "Root Project", rootDir, "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("cwdproj", "Cwd Project", cwd, "2026-01-01T00:00:00.000Z");

    const fakeRoots = async () => [rootDir];
    const result = await requireProject(db, {}, fakeRoots);
    // roots come first → rootproj wins
    expect(result.id).toBe("rootproj");
    db.close();
  });

  it("uses explicit project id when provided", async () => {
    const db = openFreshDb();
    const dir = makeTmpDir();
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("myproj", "My Project", dir, "2026-01-01T00:00:00.000Z");

    const result = await requireProject(db, { project: "myproj" }, NO_ROOTS);
    expect(result.id).toBe("myproj");
    db.close();
  });

  it("throws McpError when explicit project does not exist", async () => {
    const db = openFreshDb();
    await expect(requireProject(db, { project: "nonexistent" }, NO_ROOTS)).rejects.toThrow(McpError);
    db.close();
  });

  it("throws McpError when no candidate matches", async () => {
    const db = openFreshDb();
    // NO_ROOTS + cwd not registered → no match
    await expect(requireProject(db, {}, NO_ROOTS)).rejects.toThrow(McpError);
    db.close();
  });

  it("throws McpError when project: 'all' and allowAll is false/omitted", async () => {
    const db = openFreshDb();
    await expect(requireProject(db, { project: "all" }, NO_ROOTS)).rejects.toThrow(McpError);
    db.close();
  });

  it("returns sentinel when project: 'all' and allowAll: true", async () => {
    const db = openFreshDb();
    const result = await requireProject(db, { project: "all", allowAll: true }, NO_ROOTS);
    expect(result.id).toBe("all");
    db.close();
  });

  it("throws McpError for reserved id 'current'", async () => {
    const db = openFreshDb();
    await expect(requireProject(db, { project: "current" }, NO_ROOTS)).rejects.toThrow(McpError);
    db.close();
  });
});
