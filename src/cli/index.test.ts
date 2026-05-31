import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openDb } from "../db.js";
import { setQuiet } from "../logger.js";
import { runCli } from "./index.js";

const tmpDirs: string[] = [];
const prevDbPath = process.env["TICKETGRAPH_DB_PATH"];

function useTmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-cli-index-test-"));
  tmpDirs.push(dir);
  // Point runCli's openDb() at a throwaway DB — NEVER the live ~/.claude/tickets.db.
  process.env["TICKETGRAPH_DB_PATH"] = join(dir, "test.db");
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  // runCli flips logger quiet state; reset it so it never leaks between tests.
  setQuiet(false);
  if (prevDbPath === undefined) {
    delete process.env["TICKETGRAPH_DB_PATH"];
  } else {
    process.env["TICKETGRAPH_DB_PATH"] = prevDbPath;
  }
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runCli — command resolution", () => {
  it("returns 2 and writes a usage line for an unknown command", async () => {
    useTmpDb();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["bogus"]);

    expect(code).toBe(2);
    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("unknown command: bogus");
    expect(written).toContain("usage:");
  });

  it("returns 2 and writes usage when no command is given", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli([]);

    expect(code).toBe(2);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("usage:");
  });

  it("never calls process.exit", async () => {
    useTmpDb();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    await runCli(["bogus"]);

    expect(exit).not.toHaveBeenCalled();
  });

  it("--version resolves 0 and prints the semver without opening the DB", async () => {
    // No useTmpDb(): TICKETGRAPH_DB_PATH is unset here, proving no DB is opened.
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const code = await runCli(["--version"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help resolves 0 and lists known commands without opening the DB", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const code = await runCli(["--help"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("list");
    expect(written).toContain("--mcp");
  });

  it("bogus --help (unknown command + --help) → top-level help, code 0", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const code = await runCli(["bogus", "--help"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    // Unknown command falls back to the top-level command list.
    expect(written).toContain("list");
    expect(written).toContain("--mcp");
  });

  it("<command> --help → per-command help, NOT the full command list", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const code = await runCli(["list", "--help"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    // Per-command usage header + list's own flags.
    expect(written).toContain("usage: ticketgraph list [--flags]");
    expect(written).toContain("--status");
    expect(written).toContain("--limit");
    // It is NOT the top-level command list (no --mcp server note there).
    expect(written).not.toContain("--mcp");
  });

  it("--format <val> <command> --help routes to per-command help after the format strip", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    // Proves --help routing runs AFTER extractFormat: 'json' is the --format
    // value, not the positional, so 'get' is correctly identified as the command.
    const code = await runCli(["--format", "json", "get", "--help"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("usage: ticketgraph get [--flags]");
    expect(written).not.toContain("--mcp");
  });

  it("--format bogus <command> --help → help wins over the format error (code 0)", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["--format", "bogus", "list", "--help"]);

    expect(code).toBe(0);
    expect(stderr.mock.calls).toHaveLength(0);
    expect(stdout.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "usage: ticketgraph list [--flags]",
    );
  });

  it("--format bogus list (no --help) still → exit 2 on the format error", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["--format", "bogus", "list"]);

    expect(code).toBe(2);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("compact");
  });

  it("--version wins over --help when both are present", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const code = await runCli(["list", "--help", "--version"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toMatch(/^\d+\.\d+\.\d+/);
    expect(written).not.toContain("usage: ticketgraph list");
  });

  it("--verbose list --help → list per-command help (--verbose stripping doesn't consume the command)", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    const code = await runCli(["--verbose", "list", "--help"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("usage: ticketgraph list [--flags]");
    expect(written).not.toContain("--mcp");
  });

  it("dispatches a known command and writes result JSON to stdout with --format json (code 0)", async () => {
    const dir = useTmpDb();
    // Seed the env-pointed DB with a project so requireProject resolves.
    const { db } = openDb({ path: join(dir, "test.db") });
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("proj1", "Project One", dir, "2026-01-01T00:00:00.000Z");
    db.close();

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    // The default is now compact (T24); pass --format json so the JSON.parse
    // data-correctness assertion stays meaningful.
    const code = await runCli(["list", "--format", "json", "--project", "proj1"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(written) as { project: string; rows: unknown[] };
    expect(parsed.project).toBe("proj1");
  });
});

describe("runCli — --format selection", () => {
  const prevFormat = process.env["TICKETGRAPH_FORMAT"];

  function seed(dir: string): void {
    const { db } = openDb({ path: join(dir, "test.db") });
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("proj1", "Project One", dir, "2026-01-01T00:00:00.000Z");
    db.close();
  }

  afterEach(() => {
    if (prevFormat === undefined) delete process.env["TICKETGRAPH_FORMAT"];
    else process.env["TICKETGRAPH_FORMAT"] = prevFormat;
  });

  it("defaults to compact output (no --format, no env): not valid JSON", async () => {
    const dir = useTmpDb();
    seed(dir);
    delete process.env["TICKETGRAPH_FORMAT"];
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["list", "--project", "proj1"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    // Empty list → "(none)\n" in compact, NOT a JSON object.
    expect(written.trim()).toBe("(none)");
    expect(() => JSON.parse(written) as unknown).toThrow();
  });

  it("--format=json (equals form) emits parseable single-line JSON", async () => {
    const dir = useTmpDb();
    seed(dir);
    delete process.env["TICKETGRAPH_FORMAT"];
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["list", "--format=json", "--project", "proj1"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(written) as { project: string };
    expect(parsed.project).toBe("proj1");
  });

  it("--format json (space form) emits parseable JSON and strips the value token", async () => {
    const dir = useTmpDb();
    seed(dir);
    delete process.env["TICKETGRAPH_FORMAT"];
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // --format json sits between command and --project: BOTH the flag and its
    // value token must be stripped so --project still resolves.
    const code = await runCli(["list", "--format", "json", "--project", "proj1"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(written) as { project: string };
    expect(parsed.project).toBe("proj1");
  });

  it("TICKETGRAPH_FORMAT=json env selects json when no flag is present", async () => {
    const dir = useTmpDb();
    seed(dir);
    process.env["TICKETGRAPH_FORMAT"] = "json";
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["list", "--project", "proj1"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect((JSON.parse(written) as { project: string }).project).toBe("proj1");
  });

  it("the --format flag overrides the env (flag=compact beats env=json)", async () => {
    const dir = useTmpDb();
    seed(dir);
    process.env["TICKETGRAPH_FORMAT"] = "json";
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["list", "--format", "compact", "--project", "proj1"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    expect(written.trim()).toBe("(none)");
  });

  it("--format bogus → exit 2 with a one-line usage on stderr, nothing on stdout", async () => {
    const dir = useTmpDb();
    seed(dir);
    delete process.env["TICKETGRAPH_FORMAT"];
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["list", "--format", "bogus", "--project", "proj1"]);

    expect(code).toBe(2);
    expect(stdout.mock.calls).toHaveLength(0);
    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("compact");
    expect(written.trimEnd().includes("\n")).toBe(false); // one line
  });

  it("invalid TICKETGRAPH_FORMAT env → exit 2", async () => {
    const dir = useTmpDb();
    seed(dir);
    process.env["TICKETGRAPH_FORMAT"] = "bogus";
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["list", "--project", "proj1"]);

    expect(code).toBe(2);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("compact");
  });

  it("bare trailing --format with no value → exit 2", async () => {
    const dir = useTmpDb();
    seed(dir);
    delete process.env["TICKETGRAPH_FORMAT"];
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["list", "--project", "proj1", "--format"]);

    expect(code).toBe(2);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("compact");
  });

  it("--format= (equals form, empty value) → exit 2, not silent compact", async () => {
    const dir = useTmpDb();
    seed(dir);
    delete process.env["TICKETGRAPH_FORMAT"];
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["list", "--format=", "--project", "proj1"]);

    expect(code).toBe(2);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("compact");
  });
});

describe("runCli — INFO chatter suppression", () => {
  function seed(dir: string): void {
    const { db } = openDb({ path: join(dir, "test.db") });
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("proj1", "Project One", dir, "2026-01-01T00:00:00.000Z");
    db.close();
  }

  const prevDebug = process.env["TICKETGRAPH_DEBUG"];
  afterEach(() => {
    if (prevDebug === undefined) delete process.env["TICKETGRAPH_DEBUG"];
    else process.env["TICKETGRAPH_DEBUG"] = prevDebug;
  });

  it("emits NO INFO line on stderr by default", async () => {
    const dir = useTmpDb();
    seed(dir);
    delete process.env["TICKETGRAPH_DEBUG"];
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["list", "--project", "proj1"]);

    expect(code).toBe(0);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).not.toContain("INFO");
  });

  it("--verbose re-enables the INFO line (and is stripped, so flags still parse)", async () => {
    const dir = useTmpDb();
    seed(dir);
    delete process.env["TICKETGRAPH_DEBUG"];
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // --verbose sits between command and its real flags; it must be stripped so
    // `--project proj1` still resolves and the command succeeds. --format json
    // keeps the data assertion meaningful now that compact is the default.
    const code = await runCli(["list", "--verbose", "--format", "json", "--project", "proj1"]);

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join("");
    const parsed = JSON.parse(written) as { project: string };
    expect(parsed.project).toBe("proj1");
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("INFO");
  });

  it("TICKETGRAPH_DEBUG re-enables the INFO line", async () => {
    const dir = useTmpDb();
    seed(dir);
    process.env["TICKETGRAPH_DEBUG"] = "1";
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["list", "--project", "proj1"]);

    expect(code).toBe(0);
    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toContain("INFO");
  });
});

describe("runCli — openDb failure", () => {
  it("a stale/half-init DB → code 1, stale message on stderr, nothing on stdout", async () => {
    const dir = useTmpDb();
    // Fabricate the env-pointed DB as half-init: user_version=1 but no 'projects'
    // table, mirroring db.test.ts. openDb()'s integrity guard throws on open; the
    // failure is an environment error (not usage) → exit 1, no stack on stderr.
    const raw = new Database(join(dir, "test.db"));
    raw.pragma("user_version = 1");
    raw.close();

    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const code = await runCli(["list", "--project", "proj1"]);

    expect(code).toBe(1);
    expect(stdout.mock.calls).toHaveLength(0);
    const written = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("missing the expected 'projects' table");
    expect(written).not.toContain("    at "); // no stack frames
  });
});
