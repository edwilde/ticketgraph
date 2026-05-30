/**
 * End-to-end integration test for the 5 new MCP tools + upgraded ping.
 *
 * Spawns the BUILT artifact (dist/server.js) with a fresh temp DB.
 * Walks a 7-step sequence that exercises the full tool surface through
 * the real stdio transport.
 *
 * Assumes dist/server.js is already built (server.stdio.test.ts calls
 * npm run build in its beforeAll; run `npm run build` if running this
 * file alone).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { sendRequest, waitForServerReady } from "./helpers/mcp-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVER = resolve(ROOT, "dist/server.js");

let child: ChildProcess | null = null;
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-e2e-"));
  tmpDirs.push(dir);
  return dir;
}

function spawnServer(dbPath: string): ChildProcess {
  return spawn("node", [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: ROOT,
    env: { ...process.env, TICKETGRAPH_DB_PATH: dbPath },
  });
}

async function init(proc: ChildProcess): Promise<void> {
  // Wait for the server to log readiness before the handshake — avoids a
  // cold-start race under heavy parallel test load.
  await waitForServerReady(proc);
  await sendRequest(proc, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.1" },
  });
}

async function callTool(proc: ChildProcess, name: string, toolArgs: unknown): Promise<unknown> {
  const resp = await sendRequest(proc, "tools/call", {
    name,
    arguments: toolArgs,
  }) as Record<string, unknown>;
  const result = resp["result"] as Record<string, unknown>;
  const content = result["content"] as Array<Record<string, unknown>>;
  return JSON.parse(content[0]!["text"] as string);
}

afterEach(() => {
  // Capture the specific child in a local so the SIGKILL-fallback timer can
  // only kill THIS test's process, never the next test's freshly-spawned
  // server (the module-level reference caused "code=null" flakes under load).
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

describe("MCP tools end-to-end 7-step flow", () => {
  it("walks the full sequence: list tools → register → add × 2 → list → get → stats", async () => {
    const dbDir = makeTmpDir();
    const dbPath = join(dbDir, "e2e.db");
    const projectDir = makeTmpDir(); // a real dir for root_path

    child = spawnServer(dbPath);
    await init(child);

    // Step 1: tools/list → assert all registered tools are listed.
    const toolsResp = await sendRequest(child, "tools/list", {}) as Record<string, unknown>;
    const toolList = (toolsResp["result"] as Record<string, unknown>)["tools"] as Array<Record<string, unknown>>;
    const toolNames = toolList.map((t) => t["name"] as string);
    expect(toolNames).toContain("tickets.ping");
    expect(toolNames).toContain("tickets.register_project");
    expect(toolNames).toContain("tickets.add");
    expect(toolNames).toContain("tickets.list");
    expect(toolNames).toContain("tickets.get");
    expect(toolNames).toContain("tickets.stats");
    expect(toolNames).toContain("tickets.update");
    expect(toolNames).toContain("tickets.link");
    expect(toolNames).toContain("tickets.unlink");
    expect(toolNames).toContain("tickets.set_parent");
    expect(toolNames).toContain("tickets.append_to_description");
    expect(toolNames).toContain("tickets.add_tag");
    expect(toolNames).toContain("tickets.remove_tag");
    expect(toolNames).toContain("tickets.search");
    expect(toolNames).toContain("tickets.next");
    expect(toolNames).toContain("tickets.related");
    expect(toolNames).toContain("tickets.blockers_of");
    expect(toolNames).toContain("tickets.children_of");
    expect(toolNames).toContain("tickets.changed_since");
    expect(toolNames).toContain("tickets.validate");
    expect(toolNames).toContain("tickets.import_json");
    expect(toolNames).toContain("tickets.add_many");
    expect(toolNames).toContain("tickets.export");
    expect(toolNames).toHaveLength(23);

    // Step 2: register project.
    const reg = await callTool(child, "tickets.register_project", {
      id: "demo",
      display_name: "Demo",
      root_path: projectDir,
    }) as Record<string, unknown>;
    expect(reg["id"]).toBe("demo");

    // Step 3: add first ticket.
    const add1 = await callTool(child, "tickets.add", {
      project: "demo",
      title: "First task",
    }) as { ticket: Record<string, unknown> };
    expect(add1.ticket["id"]).toBe("T1");
    expect(add1.ticket["status"]).toBe("open");

    // Step 3b: update T1 → done; then get to confirm closed_at.
    const update1 = await callTool(child, "tickets.update", {
      project: "demo",
      id: "T1",
      patch: { status: "done" },
    }) as { ticket: Record<string, unknown>; audit_entries: number };
    expect(update1.ticket["status"]).toBe("done");
    expect(update1.ticket["closed_at"]).not.toBeNull();
    expect(update1.audit_entries).toBe(1);

    const getT1 = await callTool(child, "tickets.get", {
      project: "demo",
      id: "T1",
    }) as { ticket: Record<string, unknown> };
    expect(getT1.ticket["status"]).toBe("done");
    expect(getT1.ticket["closed_at"]).not.toBeNull();

    // Step 4: add second ticket with priority and effort.
    const add2 = await callTool(child, "tickets.add", {
      project: "demo",
      title: "Second",
      priority: "P1",
      effort: 3,
    }) as { ticket: Record<string, unknown> };
    expect(add2.ticket["id"]).toBe("T2");
    expect(add2.ticket["priority"]).toBe("P1");
    expect(add2.ticket["effort"]).toBe(3);

    // Step 5: list → both tickets visible (status: "all" to include done T1).
    const list = await callTool(child, "tickets.list", { project: "demo", status: "all" }) as {
      project: string;
      count: number;
      rows: unknown[];
    };
    expect(list.project).toBe("demo");
    expect(list.count).toBe(2);
    expect(list.rows).toHaveLength(2);

    // Step 6: get T2 → full ticket with recent_audit having 1 _created row.
    const get = await callTool(child, "tickets.get", {
      project: "demo",
      id: "T2",
    }) as { ticket: Record<string, unknown> };
    expect(get.ticket["id"]).toBe("T2");
    const audit = get.ticket["recent_audit"] as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!["field"]).toBe("_created");

    // Step 7: stats → by_status { open: 1, done: 1 }, totals tickets=2, points=3.
    const stats = await callTool(child, "tickets.stats", { project: "demo" }) as {
      project: string;
      by_status: Record<string, number>;
      totals: { tickets: number; points: number };
    };
    expect(stats.project).toBe("demo");
    expect(stats.by_status["open"]).toBe(1);
    expect(stats.by_status["done"]).toBe(1);
    expect(stats.totals.tickets).toBe(2);
    expect(stats.totals.points).toBe(3);

    // Step 8: link T1 blocks T2 → relation created.
    const link = await callTool(child, "tickets.link", {
      project: "demo",
      from: "T1",
      to: "T2",
      kind: "blocks",
    }) as { from: string; to: string; kind: string; note: null; created_at: string };
    expect(link.from).toBe("T1");
    expect(link.to).toBe("T2");
    expect(link.kind).toBe("blocks");

    // Step 9: set_parent T2 → parent T1.
    const setParent = await callTool(child, "tickets.set_parent", {
      project: "demo",
      id: "T2",
      parent_id: "T1",
    }) as { ticket: Record<string, unknown>; changed: boolean };
    expect(setParent.ticket["parent_id"]).toBe("T1");
    expect(setParent.changed).toBe(true);

    // Step 10: append_to_description on T1 (currently empty due to update to done, not desc).
    const append = await callTool(child, "tickets.append_to_description", {
      project: "demo",
      id: "T1",
      text: "extra note",
    }) as { ticket: Record<string, unknown> };
    expect(append.ticket["description"]).toBe("extra note");

    // Step 11: add_tag "Urgent" to T1 → normalised to "urgent".
    const addTag = await callTool(child, "tickets.add_tag", {
      project: "demo",
      id: "T1",
      tag: "Urgent",
    }) as { tags: string[] };
    expect(addTag.tags).toContain("urgent");

    // Step 12: get T1 → confirm blocks relation, appended description, normalised tag.
    const getT1Final = await callTool(child, "tickets.get", {
      project: "demo",
      id: "T1",
    }) as { ticket: Record<string, unknown> };
    expect(getT1Final.ticket["description"]).toBe("extra note");
    const finalTags = getT1Final.ticket["tags"] as string[];
    expect(finalTags).toContain("urgent");
    const relations = getT1Final.ticket["relations"] as {
      outgoing: Record<string, Array<{ id: string; note: string | null }>>;
      incoming: Record<string, Array<{ id: string; note: string | null }>>;
    };
    expect(relations.outgoing["blocks"]).toBeDefined();
    expect(relations.outgoing["blocks"]![0]!["id"]).toBe("T2");

    // Step 13: search — find "Second" ticket by title word.
    const search = await callTool(child, "tickets.search", {
      project: "demo",
      q: "Second",
      include_done: true,
    }) as { project: string; count: number; hits: Array<Record<string, unknown>> };
    expect(search.count).toBeGreaterThanOrEqual(1);
    const searchHit = search.hits[0]!;
    expect(typeof searchHit["snippet"]).toBe("string");
    expect(typeof searchHit["score"]).toBe("number");
    expect(searchHit["id"]).toBe("T2");

    // Step 14: next → T1 is done so doesn't block T2; T2 is open and unblocked → next returns T2.
    const next = await callTool(child, "tickets.next", {
      project: "demo",
    }) as { ticket: Record<string, unknown> | null; reason: Record<string, unknown> | null };
    expect(next.ticket).not.toBeNull();
    expect(next.ticket!["id"]).toBe("T2");
    expect(next.reason!["no_open_blockers"]).toBe(true);

    // Step 15: blockers_of T2 → T1 appears (structural; done status doesn't exclude from blockers_of).
    const blockersOf = await callTool(child, "tickets.blockers_of", {
      project: "demo",
      id: "T2",
    }) as { id: string; blockers: Array<Record<string, unknown>> };
    expect(blockersOf.blockers.some((b) => b["id"] === "T1")).toBe(true);

    // Step 16: children_of T1 → T2 appears.
    const childrenOf = await callTool(child, "tickets.children_of", {
      project: "demo",
      id: "T1",
    }) as { id: string; children: Array<Record<string, unknown>> };
    expect(childrenOf.children.some((c) => c["id"] === "T2")).toBe(true);

    // Step 17: changed_since a far-past date → includes the status→done change for T1.
    const changed = await callTool(child, "tickets.changed_since", {
      project: "demo",
      since: "2000-01-01",
      field: "status",
      new_value: "done",
    }) as { project: string; count: number; changes: Array<Record<string, unknown>> };
    expect(changed.count).toBeGreaterThanOrEqual(1);
    expect(changed.changes.some((c) => c["ticket_id"] === "T1" && c["new_value"] === "done")).toBe(true);

    // Step 18: validate → ok: true (clean project).
    const validated = await callTool(child, "tickets.validate", {
      project: "demo",
    }) as { project: string; ok: boolean; issues: unknown[] };
    expect(validated.ok).toBe(true);
  }, 30_000);

  it("upgraded ping returns { ok, version, db_path, schema_version }", async () => {
    const dbDir = makeTmpDir();
    const dbPath = join(dbDir, "ping.db");
    child = spawnServer(dbPath);
    await init(child);

    const ping = await callTool(child, "tickets.ping", {}) as Record<string, unknown>;
    expect(ping["ok"]).toBe(true);
    expect(ping["version"]).toMatch(/^\d+\.\d+\.\d+/);
    expect(ping["db_path"]).toBe(dbPath);
    expect(ping["schema_version"]).toBe(1);
  }, 15_000);
});
