import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeAddTool } from "./add.js";
import { makeLinkTool } from "./link.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-link-test-"));
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

  const addTool = makeAddTool(db);
  const linkTool = makeLinkTool(db);

  async function addTicket(title = "Test ticket") {
    return addTool.handle(addTool.parseArgs({ project: "proj1", title }));
  }

  function auditRows(ticketId: string) {
    return db
      .prepare(
        "SELECT field, old_value, new_value FROM audit_log WHERE project_id = ? AND ticket_id = ? AND field != '_created' ORDER BY id",
      )
      .all("proj1", ticketId) as Array<{
        field: string;
        old_value: string | null;
        new_value: string | null;
      }>;
  }

  return { db, addTicket, linkTool, auditRows };
}

describe("tickets.link", () => {
  it("creates relation for known kind + writes correct audit row", async () => {
    const { db, addTicket, linkTool, auditRows } = setup();
    const { ticket: t1 } = await addTicket("T1");
    const { ticket: t2 } = await addTicket("T2");

    const result = await linkTool.handle(
      linkTool.parseArgs({ project: "proj1", from: t1.id, to: t2.id, kind: "blocks" }),
    );

    expect(result.from).toBe(t1.id);
    expect(result.to).toBe(t2.id);
    expect(result.kind).toBe("blocks");
    expect(result.note).toBeNull();

    // Verify relation row in DB.
    const relRow = db
      .prepare(
        "SELECT * FROM relations WHERE project_id = ? AND from_id = ? AND to_id = ? AND kind = ?",
      )
      .get("proj1", t1.id, t2.id, "blocks");
    expect(relRow).toBeDefined();

    // Verify audit row shape.
    const rows = auditRows(t1.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.field).toBe("relation:blocks");
    expect(rows[0]!.old_value).toBeNull();
    expect(rows[0]!.new_value).toBe(`${t1.id}->${t2.id}`);
    db.close();
  });

  it("unknown kind without force → InvalidParams", async () => {
    const { db, addTicket, linkTool } = setup();
    const { ticket: t1 } = await addTicket("T1");
    const { ticket: t2 } = await addTicket("T2");

    await expect(
      linkTool.handle(
        linkTool.parseArgs({ project: "proj1", from: t1.id, to: t2.id, kind: "custom_kind" }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("unknown kind with force: true → succeeds", async () => {
    const { db, addTicket, linkTool } = setup();
    const { ticket: t1 } = await addTicket("T1");
    const { ticket: t2 } = await addTicket("T2");

    const result = await linkTool.handle(
      linkTool.parseArgs({ project: "proj1", from: t1.id, to: t2.id, kind: "custom_kind", force: true }),
    );
    expect(result.kind).toBe("custom_kind");
    db.close();
  });

  it("non-existent from ticket → InvalidParams", async () => {
    const { db, addTicket, linkTool } = setup();
    const { ticket: t2 } = await addTicket("T2");

    await expect(
      linkTool.handle(
        linkTool.parseArgs({ project: "proj1", from: "NO-SUCH", to: t2.id, kind: "blocks" }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("non-existent to ticket → InvalidParams", async () => {
    const { db, addTicket, linkTool } = setup();
    const { ticket: t1 } = await addTicket("T1");

    await expect(
      linkTool.handle(
        linkTool.parseArgs({ project: "proj1", from: t1.id, to: "NO-SUCH", kind: "blocks" }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("self-relation (from === to) → InvalidParams", async () => {
    const { db, addTicket, linkTool } = setup();
    const { ticket: t1 } = await addTicket("T1");

    await expect(
      linkTool.handle(
        linkTool.parseArgs({ project: "proj1", from: t1.id, to: t1.id, kind: "blocks" }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("duplicate link → InvalidParams (already exists)", async () => {
    const { db, addTicket, linkTool } = setup();
    const { ticket: t1 } = await addTicket("T1");
    const { ticket: t2 } = await addTicket("T2");

    await linkTool.handle(
      linkTool.parseArgs({ project: "proj1", from: t1.id, to: t2.id, kind: "blocks" }),
    );

    await expect(
      linkTool.handle(
        linkTool.parseArgs({ project: "proj1", from: t1.id, to: t2.id, kind: "blocks" }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("note is stored and returned", async () => {
    const { db, addTicket, linkTool } = setup();
    const { ticket: t1 } = await addTicket("T1");
    const { ticket: t2 } = await addTicket("T2");

    const result = await linkTool.handle(
      linkTool.parseArgs({
        project: "proj1",
        from: t1.id,
        to: t2.id,
        kind: "relates_to",
        note: "see ticket for context",
      }),
    );
    expect(result.note).toBe("see ticket for context");
    db.close();
  });
});
