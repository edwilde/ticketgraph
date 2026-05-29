import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeAddTool } from "./add.js";
import { makeSetParentTool } from "./set_parent.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-set-parent-test-"));
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
  const setParentTool = makeSetParentTool(db);

  async function addTicket(title = "Test ticket", extra: Record<string, unknown> = {}) {
    return addTool.handle(addTool.parseArgs({ project: "proj1", title, ...extra }));
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

  return { db, addTicket, setParentTool, auditRows };
}

describe("tickets.set_parent", () => {
  it("sets parent → parent_id updated + 1 audit row", async () => {
    const { db, addTicket, setParentTool, auditRows } = setup();
    const { ticket: parent } = await addTicket("Parent");
    const { ticket: child } = await addTicket("Child");

    const result = await setParentTool.handle(
      setParentTool.parseArgs({ project: "proj1", id: child.id, parent_id: parent.id }),
    );

    expect(result.ticket.parent_id).toBe(parent.id);
    expect(result.changed).toBe(true);

    const rows = auditRows(child.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.field).toBe("parent_id");
    expect(rows[0]!.old_value).toBeNull();
    expect(rows[0]!.new_value).toBe(parent.id);
    db.close();
  });

  it("clears parent (null) → parent_id NULL + audit shows old=parent, new=null", async () => {
    const { db, addTicket, setParentTool, auditRows } = setup();
    const { ticket: parent } = await addTicket("Parent");
    const { ticket: child } = await addTicket("Child", { parent_id: parent.id });

    const result = await setParentTool.handle(
      setParentTool.parseArgs({ project: "proj1", id: child.id, parent_id: null }),
    );

    expect(result.ticket.parent_id).toBeNull();
    expect(result.changed).toBe(true);

    const rows = auditRows(child.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.field).toBe("parent_id");
    expect(rows[0]!.old_value).toBe(parent.id);
    expect(rows[0]!.new_value).toBeNull();
    db.close();
  });

  it("self-parent → InvalidParams", async () => {
    const { db, addTicket, setParentTool } = setup();
    const { ticket: t1 } = await addTicket("T1");

    await expect(
      setParentTool.handle(
        setParentTool.parseArgs({ project: "proj1", id: t1.id, parent_id: t1.id }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("cycle detection → InvalidParams (A→B exists, setting B's parent to A would cycle)", async () => {
    const { db, addTicket, setParentTool } = setup();
    const { ticket: a } = await addTicket("A");
    const { ticket: b } = await addTicket("B", { parent_id: a.id });

    // B's parent is A; setting A's parent to B creates A→B→A
    await expect(
      setParentTool.handle(
        setParentTool.parseArgs({ project: "proj1", id: a.id, parent_id: b.id }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("non-existent parent → InvalidParams", async () => {
    const { db, addTicket, setParentTool } = setup();
    const { ticket: t1 } = await addTicket("T1");

    await expect(
      setParentTool.handle(
        setParentTool.parseArgs({ project: "proj1", id: t1.id, parent_id: "NO-SUCH" }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("no-op (same parent) → 0 audit rows, changed: false", async () => {
    const { db, addTicket, setParentTool, auditRows } = setup();
    const { ticket: parent } = await addTicket("Parent");
    const { ticket: child } = await addTicket("Child", { parent_id: parent.id });

    const result = await setParentTool.handle(
      setParentTool.parseArgs({ project: "proj1", id: child.id, parent_id: parent.id }),
    );

    expect(result.changed).toBe(false);
    const rows = auditRows(child.id);
    expect(rows).toHaveLength(0);
    db.close();
  });

  it("no-op (null → null) → 0 audit rows, changed: false", async () => {
    const { db, addTicket, setParentTool, auditRows } = setup();
    const { ticket: t1 } = await addTicket("T1");

    const result = await setParentTool.handle(
      setParentTool.parseArgs({ project: "proj1", id: t1.id, parent_id: null }),
    );

    expect(result.changed).toBe(false);
    const rows = auditRows(t1.id);
    expect(rows).toHaveLength(0);
    db.close();
  });
});
