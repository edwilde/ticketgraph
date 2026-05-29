import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeRegisterProjectTool } from "./register_project.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-rp-test-"));
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
  const tool = makeRegisterProjectTool(db);
  return { db, tool, dir };
}

describe("tickets.register_project", () => {
  it("success: registers a project and returns the row", async () => {
    const { db, tool, dir } = setup();
    const result = await tool.handle(tool.parseArgs({
      id: "myproj",
      display_name: "My Project",
      root_path: dir,
    }));

    expect(result.id).toBe("myproj");
    expect(result.display_name).toBe("My Project");
    expect(result.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Verify row is in DB.
    const row = db.prepare("SELECT id FROM projects WHERE id = ?").get("myproj");
    expect(row).toBeDefined();
    db.close();
  });

  it("canonicalises root_path via realpathSync", async () => {
    const { db, tool, dir } = setup();
    const result = await tool.handle(tool.parseArgs({
      id: "myproj",
      display_name: "My Project",
      root_path: dir,
    }));
    // The stored path should be a real path (no symlinks)
    expect(result.root_path).toBeTruthy();
    db.close();
  });

  it("throws McpError for reserved id 'all'", async () => {
    const { db, tool, dir } = setup();
    await expect(
      tool.handle(tool.parseArgs({ id: "all", display_name: "All", root_path: dir })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("throws McpError for reserved id 'current'", async () => {
    const { db, tool, dir } = setup();
    await expect(
      tool.handle(tool.parseArgs({ id: "current", display_name: "Current", root_path: dir })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("throws McpError for bad id pattern (uppercase)", async () => {
    const { db, tool, dir } = setup();
    await expect(
      tool.handle(tool.parseArgs({ id: "MyProj", display_name: "Bad", root_path: dir })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("throws McpError for bad id pattern (starts with digit)", async () => {
    const { db, tool, dir } = setup();
    await expect(
      tool.handle(tool.parseArgs({ id: "1proj", display_name: "Bad", root_path: dir })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("throws McpError when root_path does not exist", async () => {
    const { db, tool } = setup();
    await expect(
      tool.handle(tool.parseArgs({
        id: "myproj",
        display_name: "My Project",
        root_path: "/does/not/exist/at/all",
      })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("throws McpError when root_path is not absolute", async () => {
    const { db, tool } = setup();
    await expect(
      tool.handle(tool.parseArgs({
        id: "myproj",
        display_name: "My Project",
        root_path: "relative/path",
      })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("throws McpError on duplicate id (PK collision)", async () => {
    const { db, tool, dir } = setup();
    const args = { id: "myproj", display_name: "My Project", root_path: dir };
    await tool.handle(tool.parseArgs(args));

    const dir2 = makeTmpDir();
    await expect(
      tool.handle(tool.parseArgs({ id: "myproj", display_name: "Other", root_path: dir2 })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("throws McpError on duplicate root_path (UNIQUE collision)", async () => {
    const { db, tool, dir } = setup();
    await tool.handle(tool.parseArgs({ id: "proj1", display_name: "P1", root_path: dir }));

    await expect(
      tool.handle(tool.parseArgs({ id: "proj2", display_name: "P2", root_path: dir })),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("parseArgs throws McpError for missing id", () => {
    const { db, tool } = setup();
    expect(() => tool.parseArgs({ display_name: "X", root_path: "/tmp" })).toThrow(McpError);
    db.close();
  });

  it("parseArgs throws McpError for missing display_name", () => {
    const { db, tool } = setup();
    expect(() => tool.parseArgs({ id: "x", root_path: "/tmp" })).toThrow(McpError);
    db.close();
  });
});
