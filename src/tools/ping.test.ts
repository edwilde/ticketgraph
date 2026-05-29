import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { openDb } from "../db.js";
import { makePingTool } from "./ping.js";

vi.mock("../version.js", () => ({
  getPackageVersion: () => "1.2.3",
}));

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-ping-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("makePingTool", () => {
  it("returns { ok: true, version, db_path, schema_version }", async () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "test.db");
    const { db } = openDb({ path: dbPath });
    const pingTool = makePingTool({ db, dbPath });

    const result = await pingTool.handle({});

    expect(result.ok).toBe(true);
    expect(result.version).toBe("1.2.3");
    expect(result.db_path).toBe(dbPath);
    expect(result.schema_version).toBe(1);

    db.close();
  });

  it("has the correct tool name", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "test.db");
    const { db } = openDb({ path: dbPath });
    const pingTool = makePingTool({ db, dbPath });

    expect(pingTool.name).toBe("tickets.ping");

    db.close();
  });

  it("description mentions db_path and schema_version", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "test.db");
    const { db } = openDb({ path: dbPath });
    const pingTool = makePingTool({ db, dbPath });

    expect(pingTool.description).toMatch(/db_path/);
    expect(pingTool.description).toMatch(/schema_version/);

    db.close();
  });
});
