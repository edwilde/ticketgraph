/**
 * Stdio smoke integration test.
 *
 * Spawns the BUILT artifact (dist/server.js) — not TS through tsx.
 * This validates the actual shipped artifact and fails loudly if the
 * wire format changes.
 *
 * NOTE: `npm run build` is called once in beforeAll. This is intentional
 * and keeps the build coupling visible here. Do not replicate it in other
 * integration test files — switch to vitest globalSetup when a second
 * integration file appears.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { sendRequest, waitForServerReady } from "./helpers/mcp-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVER = resolve(ROOT, "dist/server.js");

let child: ChildProcess | null = null;
const tmpDirs: string[] = [];

// Spawn against an isolated temp DB — never touch the live ~/.claude/tickets.db
// (spec §16: tests never touch the live DB). Without this the server's startup
// openDb() would open the real database.
function spawnServer(args: string[] = []): ChildProcess {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-stdio-"));
  tmpDirs.push(dir);
  return spawn("node", [SERVER, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: ROOT,
    env: { ...process.env, TICKETGRAPH_DB_PATH: join(dir, "test.db") },
  });
}

afterEach(() => {
  // Capture the specific child in a local: the SIGKILL-fallback timer must only
  // ever kill THIS test's process. Referencing the module-level `child` would
  // let a slow-to-die child's timer kill the NEXT test's freshly-spawned server
  // (observed as "Server closed (code=null)" flakes under parallel load).
  const c = child;
  child = null;
  if (c && c.exitCode === null) {
    c.kill("SIGTERM");
    setTimeout(() => {
      if (c.exitCode === null) c.kill("SIGKILL");
    }, 1000);
  }
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("MCP stdio smoke", () => {
  it("initialize returns serverInfo with name ticketgraph and a semver version", async () => {
    child = spawnServer();
    await waitForServerReady(child);

const resp = await sendRequest(child, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    }) as Record<string, unknown>;

    expect(resp).toMatchObject({ jsonrpc: "2.0" });
    const result = resp["result"] as Record<string, unknown>;
    expect(result).toBeDefined();
    expect(result["protocolVersion"]).toBeDefined();
    const serverInfo = result["serverInfo"] as Record<string, unknown>;
    expect(serverInfo["name"]).toBe("ticketgraph");
    expect(serverInfo["version"]).toMatch(/^\d+\.\d+\.\d+/);
  }, 20000);

  it("tools/list includes tickets.ping with the expected description", async () => {
    child = spawnServer();
    await waitForServerReady(child);

// Must initialize before tools/list
    await sendRequest(child, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    });

    const resp = await sendRequest(child, "tools/list", {}) as Record<string, unknown>;
    const result = resp["result"] as Record<string, unknown>;
    const tools = result["tools"] as Array<Record<string, unknown>>;

    const ping = tools.find((t) => t["name"] === "tickets.ping");
    expect(ping).toBeDefined();
    expect(ping!["description"]).toMatch(/Liveness check/);
    expect(ping!["description"]).toMatch(/db_path/);
  }, 20000);

  it("tools/call tickets.ping returns { ok: true, version: <semver> }", async () => {
    child = spawnServer();
    await waitForServerReady(child);

await sendRequest(child, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    });

    const resp = await sendRequest(child, "tools/call", {
      name: "tickets.ping",
      arguments: {},
    }) as Record<string, unknown>;

    const result = resp["result"] as Record<string, unknown>;
    const content = result["content"] as Array<Record<string, unknown>>;
    expect(content[0]!["type"]).toBe("text");
    const payload = JSON.parse(content[0]!["text"] as string) as Record<string, unknown>;
    expect(payload["ok"]).toBe(true);
    expect(payload["version"]).toMatch(/^\d+\.\d+\.\d+/);
  }, 20000);

  it("`mcp` subcommand boots the MCP server and initialize returns name ticketgraph", async () => {
    child = spawnServer(["mcp"]);
    await waitForServerReady(child);

    const resp = await sendRequest(child, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    }) as Record<string, unknown>;

    const result = resp["result"] as Record<string, unknown>;
    const serverInfo = result["serverInfo"] as Record<string, unknown>;
    expect(serverInfo["name"]).toBe("ticketgraph");
  }, 20000);

  it("`--mcp` flag still boots the MCP server (regression)", async () => {
    child = spawnServer(["--mcp"]);
    await waitForServerReady(child);

    const resp = await sendRequest(child, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.1" },
    }) as Record<string, unknown>;

    const result = resp["result"] as Record<string, unknown>;
    const serverInfo = result["serverInfo"] as Record<string, unknown>;
    expect(serverInfo["name"]).toBe("ticketgraph");
  }, 20000);
});
