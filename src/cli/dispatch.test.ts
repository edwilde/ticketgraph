import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { openDb } from "../db.js";
import { makeListTool } from "../tools/list.js";
import { makeAddManyTool } from "../tools/add_many.js";
import { makeGetTool } from "../tools/get.js";
import type { AnyTool } from "../tools/types.js";
import { dispatch } from "./dispatch.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-cli-dispatch-test-"));
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
  return { db, dir };
}

function insertTicket(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO tickets (id, project_id, title, description, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, "proj1", `Title ${id}`, `Desc ${id}`, "open", "2026-01-01T00:00:00.000Z");
}

describe("dispatch — success", () => {
  it("list with --format json prints single-line JSON matching tool.handle", async () => {
    const { db } = setup();
    insertTicket(db, "T1");
    const tool = makeListTool(db);

    // json format reproduces the pre-T24 byte-identical single-line output, so
    // the data-correctness assertion (round-trip vs tool.handle) stays meaningful.
    const out = await dispatch(tool, "list", ["--project", "proj1"], { format: "json" });

    expect(out.code).toBe(0);
    expect(out.stderr).toBe("");
    // Single-line JSON: exactly one trailing newline, no internal newlines.
    expect(out.stdout.endsWith("\n")).toBe(true);
    expect(out.stdout.trimEnd().includes("\n")).toBe(false);

    const expected = await tool.handle(tool.parseArgs({ project: "proj1" }));
    expect(JSON.parse(out.stdout)).toEqual(expected);
  });

  it("list with the default format (compact) renders a headerless ticket row, not JSON", async () => {
    const { db } = setup();
    insertTicket(db, "T1");
    const tool = makeListTool(db);

    // No format dep → default "compact". The breaking change: default output is
    // no longer JSON. One ticket-row line, id-first, NOT parseable as JSON.
    const out = await dispatch(tool, "list", ["--project", "proj1"]);

    expect(out.code).toBe(0);
    expect(out.stdout.startsWith("T1 ")).toBe(true);
    expect(() => JSON.parse(out.stdout) as unknown).toThrow();
  });

  it("get T1 (compact default) renders a single ticket-row line", async () => {
    const { db } = setup();
    insertTicket(db, "T1");
    const tool = makeGetTool(db);

    const out = await dispatch(tool, "get", ["T1", "--project", "proj1"]);

    expect(out.code).toBe(0);
    // compact single-ticket: one line, starts with the id.
    expect(out.stdout.startsWith("T1 ")).toBe(true);
    expect(out.stdout.trimEnd().includes("\n")).toBe(false);
  });

  it("get T1 with --format json returns the ticket payload", async () => {
    const { db } = setup();
    insertTicket(db, "T1");
    const tool = makeGetTool(db);

    const out = await dispatch(tool, "get", ["T1", "--project", "proj1"], { format: "json" });

    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout) as { ticket: { id: string } };
    expect(parsed.ticket.id).toBe("T1");
  });

  it("add_many via --json (with --format json) creates tickets", async () => {
    const { db } = setup();
    const tool = makeAddManyTool(db);

    const out = await dispatch(
      tool,
      "add_many",
      ["--json", '{"project":"proj1","tickets":[{"id":"X1","title":"new"}]}'],
      { format: "json" },
    );

    expect(out.code).toBe(0);
    const parsed = JSON.parse(out.stdout) as { created: string[]; count: number };
    expect(parsed.created).toContain("X1");
    expect(parsed.count).toBe(1);
  });
});

describe("dispatch — errors", () => {
  it("input error (unknown project, McpError) → one stderr line, code 2, empty stdout", async () => {
    const { db } = setup();
    const tool = makeListTool(db);

    // requireProject throws McpError(InvalidParams) for an unregistered --project:
    // a user-supplied bad project id is an input/usage fault → code 2.
    const out = await dispatch(tool, "list", ["--project", "nope"]);

    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr.trimEnd().includes("\n")).toBe(false);
    expect(out.stderr).toContain("not registered");
    expect(out.stderr).not.toContain("at "); // no stack frames
  });

  it("structural error (unknown flag) → stderr, code 2, empty stdout", async () => {
    const { db } = setup();
    const tool = makeListTool(db);

    const out = await dispatch(tool, "list", ["--bogus", "x"]);

    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("unknown flag");
  });

  it("add_many with flags (no --json) → code 2 with the explicit hatch message", async () => {
    const { db } = setup();
    const tool = makeAddManyTool(db);

    const out = await dispatch(tool, "add_many", ["--project", "proj1"]);

    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("add_many requires --json");
  });

  it("tool McpError (get with neither id nor ids) → code 2 (usage/input)", async () => {
    const { db } = setup();
    const tool = makeGetTool(db);

    // get's parseArgs throws a REAL McpError(InvalidParams) when no id/ids — this
    // proves cross-module `instanceof McpError` matching, not a hand-rolled error.
    const out = await dispatch(tool, "get", ["--project", "proj1"]);

    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("Either id or ids must be supplied");
    expect(out.stderr).not.toContain("at "); // no stack frames
  });

  it("plain Error from handle stays code 1 (runtime, not usage)", async () => {
    // A tool whose handle throws a non-McpError (any unexpected runtime fault).
    const boomTool: AnyTool = {
      name: "boom",
      description: "throws a plain Error",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      parseArgs: () => ({}),
      handle: () => {
        throw new Error("kaboom");
      },
    } as unknown as AnyTool;

    const out = await dispatch(boomTool, "boom", []);

    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("kaboom");
  });
});
