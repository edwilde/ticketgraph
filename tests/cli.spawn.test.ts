/**
 * CLI spawn integration test.
 *
 * Spawns the BUILT artifact (dist/server.js) in CLI mode — `node dist/server.js
 * <command> [--flags]` — and exercises it end-to-end against an isolated temp
 * DB. This is the one thing the CLI unit tests (src/cli/*.test.ts) can't cover:
 * the real process boundary, exit codes, and stdout/stderr separation of the
 * shipped artifact.
 *
 * The build runs ONCE via the vitest globalSetup (tests/helpers/global-setup.ts);
 * this file does NOT build (no beforeAll) — it shares the artifact.
 *
 * CLI processes never log the MCP "ticketgraph starting" line, so the mcp-client
 * helpers (waitForServerReady / sendRequest) are NOT used for CLI commands —
 * they'd reject with "closed before ready". Instead runCliSpawn() collects
 * stdout/stderr and awaits the child's natural exit. The mcp-client helpers are
 * reused ONLY by the no-args regression test, which proves no-args still boots
 * the MCP server.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { sendRequest, waitForServerReady } from "./helpers/mcp-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVER = resolve(ROOT, "dist/server.js");

// One temp DB per test, seeded with a `cli_spawn` project so every tool command
// can pass `--project cli_spawn` and resolve by id (never depends on the test
// runner's cwd, never touches the live ~/.claude/tickets.db — spec §16).
let dbPath = "";
const tmpDirs: string[] = [];
// Module-scope handle ONLY for the no-args MCP test, which spawns a long-lived
// server. CLI children exit on their own and are awaited, so they don't need it.
let child: ChildProcess | null = null;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the built artifact in CLI mode, optionally piping `stdin`, and resolve
 * with the collected stdout/stderr and exit code once the child exits. stdin is
 * always closed (the CLI path never reads it unless `--json -` is used), so a
 * command can never hang waiting on input.
 */
function runCliSpawn(args: string[], opts: { stdin?: string } = {}): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn("node", [SERVER, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ROOT,
      env: { ...process.env, TICKETGRAPH_DB_PATH: dbPath },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer | string) => {
      stdout += c.toString();
    });
    proc.stderr?.on("data", (c: Buffer | string) => {
      stderr += c.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });

    if (opts.stdin !== undefined) {
      proc.stdin?.write(opts.stdin);
    }
    proc.stdin?.end();
  });
}

/**
 * Assert a success-path command emitted no ERROR diagnostic on stderr. stderr
 * is the "diagnostics only" stream, so a benign startup line (e.g. the
 * `INFO migrations: applied …` log) is expected and allowed; only error-level
 * output or a V8 stack trace would signal a real failure.
 */
function expectNoErrorOnStderr(stderr: string): void {
  expect(stderr).not.toContain("ERROR");
  expect(stderr).not.toContain("    at ");
}

function seedProject(): void {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-cli-spawn-"));
  tmpDirs.push(dir);
  dbPath = join(dir, "test.db");
  const { db } = openDb({ path: dbPath });
  db.prepare(
    "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
  ).run("cli_spawn", "CLI Spawn", dir, "2026-01-01T00:00:00.000Z");
  db.close();
}

afterEach(() => {
  // Mirror the stdio test's SIGKILL-timer discipline: copy the module-level
  // child into a local FIRST, so a slow-to-die server's fallback timer can only
  // ever kill THIS test's process — never the next test's freshly-spawned one
  // (the documented "code=null" flake under parallel load).
  const c = child;
  child = null;
  if (c && c.exitCode === null) {
    c.kill("SIGTERM");
    setTimeout(() => {
      if (c.exitCode === null) c.kill("SIGKILL");
    }, 1000);
  }
  dbPath = "";
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CLI spawn integration (dist/server.js)", () => {
  // Acceptance 1: no-args boots the MCP server, not the CLI.
  it("no-args boots the MCP server (responds to a ping, does not exit)", { timeout: 20000 }, async () => {
    seedProject();
    child = spawn("node", [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ROOT,
      env: { ...process.env, TICKETGRAPH_DB_PATH: dbPath },
    });

    // The MCP path logs "ticketgraph starting"; the CLI path never does. If
    // no-args had run the CLI, waitForServerReady would reject — proving mode.
    await waitForServerReady(child);

    await sendRequest(child, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    });

    const resp = (await sendRequest(child, "tools/call", {
      name: "tickets.ping",
      arguments: {},
    })) as Record<string, unknown>;

    const result = resp["result"] as Record<string, unknown>;
    const content = result["content"] as Array<Record<string, unknown>>;
    const payload = JSON.parse(content[0]!["text"] as string) as Record<string, unknown>;
    expect(payload["ok"]).toBe(true);
  });

  // Acceptance 2: `list --format json` → exit 0, single-line JSON of the
  // expected shape. T24 made compact the default; --format json reproduces the
  // pre-T24 byte-identical single-line output, so the data assertion stays real.
  it("list --format json --project cli_spawn → exit 0 with single-line JSON result", { timeout: 5000 }, async () => {
    seedProject();
    const r = await runCliSpawn(["list", "--format", "json", "--project", "cli_spawn"]);

    expect(r.code).toBe(0);
    expectNoErrorOnStderr(r.stderr);
    // Single-line: exactly one trailing newline, no interior newlines.
    expect(r.stdout.endsWith("\n")).toBe(true);
    expect(r.stdout.trimEnd().includes("\n")).toBe(false);
    const parsed = JSON.parse(r.stdout) as { project: string; count: number; rows: unknown[] };
    expect(parsed.project).toBe("cli_spawn");
    expect(parsed.count).toBe(0);
    expect(Array.isArray(parsed.rows)).toBe(true);
  });

  // Acceptance 2b: the DEFAULT format (compact) at the real process boundary —
  // an empty list renders "(none)", NOT a JSON object. Proves the breaking
  // change shipped end-to-end through the built artifact.
  it("list --project cli_spawn (default compact) → exit 0, empty list renders (none)", { timeout: 5000 }, async () => {
    seedProject();
    const r = await runCliSpawn(["list", "--project", "cli_spawn"]);

    expect(r.code).toBe(0);
    expectNoErrorOnStderr(r.stderr);
    expect(r.stdout.trim()).toBe("(none)");
  });

  // Acceptance 3: unknown command → exit 2, message on stderr, nothing on stdout.
  it("unknown command → exit 2, message on stderr, empty stdout", { timeout: 5000 }, async () => {
    seedProject();
    const r = await runCliSpawn(["bogus"]);

    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("unknown command: bogus");
  });

  // Acceptance 4: unknown flag → exit 2.
  it("unknown flag (list --nope x) → exit 2, message on stderr, empty stdout", { timeout: 5000 }, async () => {
    seedProject();
    const r = await runCliSpawn(["list", "--nope", "x"]);

    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("unknown flag: --nope");
  });

  // Acceptance 5: `add --format json` → exit 0, creates a ticket (JSON payload
  // on stdout). --format json keeps the data assertion meaningful.
  it("add --format json --project cli_spawn --title X → exit 0, returns the lean created id", { timeout: 5000 }, async () => {
    seedProject();
    const r = await runCliSpawn(["add", "--format", "json", "--project", "cli_spawn", "--title", "X"]);

    expect(r.code).toBe(0);
    expectNoErrorOnStderr(r.stderr);
    // Lean default: flat { id, status, created_at } — no full ticket row.
    const parsed = JSON.parse(r.stdout) as { id: string; status: string; created_at: string };
    expect("ticket" in parsed).toBe(false);
    expect(parsed.status).toBe("open");
    expect(typeof parsed.id).toBe("string");
    expect(parsed.id.length).toBeGreaterThan(0);
  });

  // Acceptance 5b: `add --full` with the DEFAULT compact format renders a single
  // ticket-row line carrying the title (no JSON braces).
  it("add --full --project cli_spawn --title X (default compact) → exit 0, single ticket-row line", { timeout: 5000 }, async () => {
    seedProject();
    const r = await runCliSpawn(["add", "--full", "--project", "cli_spawn", "--title", "X"]);

    expect(r.code).toBe(0);
    expectNoErrorOnStderr(r.stderr);
    // One line, contains the title, not a JSON object.
    expect(r.stdout.trimEnd().includes("\n")).toBe(false);
    expect(r.stdout).toContain("X");
    expect(() => JSON.parse(r.stdout) as unknown).toThrow();
  });

  // Acceptance 6: `add_many --json '<inline>'` → exit 0, creates 2.
  // The --json hatch must be the SOLE input (no other flags/positionals), so the
  // project goes INSIDE the JSON object — not as a separate --project flag. (The
  // implemented exclusivity rule rejects `add_many --project X --json …` with
  // exit 2; verified by src/cli/dispatch.test.ts.)
  it("add_many --json <inline> → exit 0, creates 2 tickets", { timeout: 5000 }, async () => {
    seedProject();
    const r = await runCliSpawn([
      "add_many",
      "--format",
      "json",
      "--json",
      '{"project":"cli_spawn","tickets":[{"title":"A"},{"title":"B"}]}',
    ]);

    expect(r.code).toBe(0);
    expectNoErrorOnStderr(r.stderr);
    const parsed = JSON.parse(r.stdout) as { created: string[]; count: number };
    expect(parsed.count).toBe(2);
    expect(parsed.created).toHaveLength(2);
  });

  // Acceptance 7: `add_many --json -` reading the SAME JSON from stdin → exit 0.
  it("add_many --json - (JSON piped on stdin) → exit 0, creates 2 tickets", { timeout: 5000 }, async () => {
    seedProject();
    const r = await runCliSpawn(
      ["add_many", "--format", "json", "--json", "-"],
      { stdin: '{"project":"cli_spawn","tickets":[{"title":"A"},{"title":"B"}]}' },
    );

    expect(r.code).toBe(0);
    expectNoErrorOnStderr(r.stderr);
    const parsed = JSON.parse(r.stdout) as { created: string[]; count: number };
    expect(parsed.count).toBe(2);
    expect(parsed.created).toHaveLength(2);
  });

  // Acceptance 8: `get <id>` (positional id) → exit 0, returns that ticket.
  it("get <id> --project cli_spawn (positional id) → exit 0, returns the ticket", { timeout: 5000 }, async () => {
    seedProject();
    // Seed via --format json so we can read the created id back as a payload.
    const created = await runCliSpawn(["add", "--format", "json", "--project", "cli_spawn", "--title", "Seed"]);
    const id = (JSON.parse(created.stdout) as { id: string }).id;

    const r = await runCliSpawn(["get", id, "--format", "json", "--project", "cli_spawn"]);

    expect(r.code).toBe(0);
    expectNoErrorOnStderr(r.stderr);
    const parsed = JSON.parse(r.stdout) as { ticket: { id: string; title: string } };
    expect(parsed.ticket.id).toBe(id);
    expect(parsed.ticket.title).toBe("Seed");
  });

  // Acceptance 8b: `get <id1> <id2> <id3>` (multiple positional ids) → exit 0,
  // returns all three tickets as a batch. Proves the T27 multi-id fix end-to-end:
  // bare positionals fold into `ids` instead of throwing the >1-positional error.
  it("get <id1> <id2> <id3> --project cli_spawn (multiple positionals) → exit 0, returns all three", { timeout: 5000 }, async () => {
    seedProject();
    // Seed THREE tickets — the fixture project starts empty, so capture each
    // generated id rather than assuming T1/T2/T3 exist.
    const ids: string[] = [];
    for (const title of ["One", "Two", "Three"]) {
      const created = await runCliSpawn(["add", "--format", "json", "--project", "cli_spawn", "--title", title]);
      ids.push((JSON.parse(created.stdout) as { id: string }).id);
    }

    const r = await runCliSpawn(["get", ids[0]!, ids[1]!, ids[2]!, "--format", "json", "--project", "cli_spawn"]);

    expect(r.code).toBe(0);
    expectNoErrorOnStderr(r.stderr);
    const parsed = JSON.parse(r.stdout) as { tickets: Array<{ id: string }> };
    expect(parsed.tickets).toHaveLength(3);
    for (const ticket of parsed.tickets) {
      expect(ids).toContain(ticket.id);
    }
  });

  // Acceptance 9: `--version` → exit 0, semver on stdout; `--help` → exit 0, command list.
  it("--version → exit 0 with semver on stdout", { timeout: 5000 }, async () => {
    seedProject();
    const r = await runCliSpawn(["--version"]);

    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help → exit 0 with the command list on stdout", { timeout: 5000 }, async () => {
    seedProject();
    const r = await runCliSpawn(["--help"]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("list");
    expect(r.stdout).toContain("--mcp");
  });

  // Acceptance 10: input error (missing ticket) → exit 2, message on stderr,
  // NO stack trace, nothing on stdout. A user-supplied not-found id is an input
  // error: the tool throws McpError(InvalidParams), which dispatch maps to 2.
  it("get NOPE --project cli_spawn (missing ticket) → exit 2, message on stderr, no stack, empty stdout", { timeout: 5000 }, async () => {
    seedProject();
    const r = await runCliSpawn(["get", "NOPE", "--project", "cli_spawn"]);

    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("not found");
    // No stack trace: error output is the message only, not a V8 stack.
    expect(r.stderr).not.toContain("    at ");
    expect(r.stderr).not.toContain(".js:");
  });
});
