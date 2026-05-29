import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeAddTool } from "./add.js";
import { makeUpdateTool } from "./update.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-update-test-"));
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
  const updateTool = makeUpdateTool(db);

  async function addTicket(opts: Record<string, unknown> = {}) {
    return addTool.handle(addTool.parseArgs({ project: "proj1", title: "Test ticket", ...opts }));
  }

  function auditRows(ticketId: string) {
    return db
      .prepare(
        "SELECT field, old_value, new_value, changed_at FROM audit_log WHERE project_id = ? AND ticket_id = ? AND field != '_created' ORDER BY id",
      )
      .all("proj1", ticketId) as Array<{
        field: string;
        old_value: string | null;
        new_value: string | null;
        changed_at: string;
      }>;
  }

  return { db, addTicket, updateTool, auditRows };
}

describe("tickets.update", () => {
  it("mark open → done sets closed_at and writes 1 status audit row", async () => {
    const { db, addTicket, updateTool, auditRows } = setup();
    const { ticket } = await addTicket();
    expect(ticket.status).toBe("open");

    const result = await updateTool.handle(
      updateTool.parseArgs({ project: "proj1", id: ticket.id, patch: { status: "done" } }),
    );

    expect(result.ticket.status).toBe("done");
    expect(result.ticket.closed_at).not.toBeNull();
    expect(result.audit_entries).toBe(1);

    const rows = auditRows(ticket.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.field).toBe("status");
    expect(rows[0]!.old_value).toBe("open");
    expect(rows[0]!.new_value).toBe("done");
    db.close();
  });

  it("mark open → deferred sets closed_at", async () => {
    const { db, addTicket, updateTool, auditRows } = setup();
    const { ticket } = await addTicket();

    const result = await updateTool.handle(
      updateTool.parseArgs({ project: "proj1", id: ticket.id, patch: { status: "deferred" } }),
    );

    expect(result.ticket.status).toBe("deferred");
    expect(result.ticket.closed_at).not.toBeNull();
    db.close();
  });

  it("re-open done → open clears closed_at; 2 total status audit rows over the flow", async () => {
    const { db, addTicket, updateTool, auditRows } = setup();
    const { ticket } = await addTicket();

    // Mark done first.
    await updateTool.handle(
      updateTool.parseArgs({ project: "proj1", id: ticket.id, patch: { status: "done" } }),
    );

    // Now re-open.
    const result = await updateTool.handle(
      updateTool.parseArgs({ project: "proj1", id: ticket.id, patch: { status: "open" } }),
    );

    expect(result.ticket.status).toBe("open");
    expect(result.ticket.closed_at).toBeNull();

    const rows = auditRows(ticket.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.field).toBe("status");
    expect(rows[1]!.field).toBe("status");
    db.close();
  });

  it("multi-field patch writes one audit row per changed field with the same changed_at", async () => {
    const { db, addTicket, updateTool, auditRows } = setup();
    const { ticket } = await addTicket();

    const result = await updateTool.handle(
      updateTool.parseArgs({
        project: "proj1",
        id: ticket.id,
        patch: { status: "in_progress", priority: "P0" },
      }),
    );

    expect(result.audit_entries).toBe(2);

    const rows = auditRows(ticket.id);
    expect(rows).toHaveLength(2);
    // All rows in the batch share the same changed_at.
    expect(rows[0]!.changed_at).toBe(rows[1]!.changed_at);
    const fields = rows.map((r) => r.field).sort();
    expect(fields).toEqual(["priority", "status"]);
    db.close();
  });

  it("no-op patch (status = current) → 0 audit rows, audit_entries: 0", async () => {
    const { db, addTicket, updateTool, auditRows } = setup();
    const { ticket } = await addTicket();

    const result = await updateTool.handle(
      updateTool.parseArgs({ project: "proj1", id: ticket.id, patch: { status: "open" } }),
    );

    expect(result.audit_entries).toBe(0);
    const rows = auditRows(ticket.id);
    expect(rows).toHaveLength(0);
    db.close();
  });

  it("description overwrite stores the full new value in new_value", async () => {
    const { db, addTicket, updateTool, auditRows } = setup();
    const { ticket } = await addTicket({ description: "original body" });

    const newDesc = "completely new description text";
    await updateTool.handle(
      updateTool.parseArgs({
        project: "proj1",
        id: ticket.id,
        patch: { description: newDesc },
      }),
    );

    const rows = auditRows(ticket.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.field).toBe("description");
    expect(rows[0]!.new_value).toBe(newDesc);
    db.close();
  });

  it("effort CHECK violation (effort=4) → McpError(InvalidParams)", async () => {
    const { db, addTicket, updateTool, auditRows } = setup();
    const { ticket } = await addTicket();

    // effort=4 passes parseArgs (not validated there beyond type) — DB catches it.
    // We bypass parseArgs validation by calling handle directly with a raw patch.
    // Actually per spec, the DB CHECK fires; the parseArgs VALID_EFFORTS set would also catch it,
    // so we test the full path: parseArgs should throw for effort=4.
    expect(() =>
      updateTool.parseArgs({ project: "proj1", id: ticket.id, patch: { effort: 4 } }),
    ).toThrow(McpError);
    db.close();
  });

  it("patching a non-existent ticket → InvalidParams", async () => {
    const { db, updateTool } = setup();

    await expect(
      updateTool.handle(
        updateTool.parseArgs({ project: "proj1", id: "NO-SUCH-TICKET", patch: { status: "done" } }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("patching a non-existent project → InvalidParams", async () => {
    const { db, updateTool } = setup();

    await expect(
      updateTool.handle(
        updateTool.parseArgs({ project: "no-such-project", id: "T1", patch: { status: "done" } }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("patching disallowed fields (id, project_id, created_at, closed_at) → InvalidParams at parseArgs", () => {
    const { db, updateTool } = setup();

    expect(() =>
      updateTool.parseArgs({ project: "proj1", id: "T1", patch: { id: "T9" } }),
    ).toThrow(McpError);

    expect(() =>
      updateTool.parseArgs({ project: "proj1", id: "T1", patch: { project_id: "other" } }),
    ).toThrow(McpError);

    expect(() =>
      updateTool.parseArgs({
        project: "proj1",
        id: "T1",
        patch: { created_at: "2026-01-01T00:00:00.000Z" },
      }),
    ).toThrow(McpError);

    expect(() =>
      updateTool.parseArgs({
        project: "proj1",
        id: "T1",
        patch: { closed_at: "2026-01-01T00:00:00.000Z" },
      }),
    ).toThrow(McpError);

    db.close();
  });

  it("parent_id: null clears the parent; audit shows old_value=parent, new_value=null", async () => {
    const { db, addTicket, updateTool, auditRows } = setup();
    // Create parent and child.
    const { ticket: parent } = await addTicket({ title: "Parent" });
    const { ticket: child } = await addTicket({ title: "Child", parent_id: parent.id });

    expect(child.parent_id).toBe(parent.id);

    const result = await updateTool.handle(
      updateTool.parseArgs({ project: "proj1", id: child.id, patch: { parent_id: null } }),
    );

    expect(result.ticket.parent_id).toBeNull();

    const rows = auditRows(child.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.field).toBe("parent_id");
    expect(rows[0]!.old_value).toBe(parent.id);
    expect(rows[0]!.new_value).toBeNull();
    db.close();
  });

  it("parent_id cycle rejection: A→B exists, setting B's parent to A → InvalidParams", async () => {
    const { db, addTicket, updateTool, auditRows } = setup();
    const { ticket: a } = await addTicket({ title: "A" });
    const { ticket: b } = await addTicket({ title: "B", parent_id: a.id });

    // B's parent is A; now try to set A's parent to B — would create A→B→A
    await expect(
      updateTool.handle(
        updateTool.parseArgs({ project: "proj1", id: a.id, patch: { parent_id: b.id } }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("parent_id to non-existent ticket → InvalidParams (FK violation)", async () => {
    const { db, addTicket, updateTool, auditRows } = setup();
    const { ticket } = await addTicket();

    await expect(
      updateTool.handle(
        updateTool.parseArgs({
          project: "proj1",
          id: ticket.id,
          patch: { parent_id: "DOES-NOT-EXIST" },
        }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("empty patch object → InvalidParams", () => {
    const { db, updateTool } = setup();

    expect(() =>
      updateTool.parseArgs({ project: "proj1", id: "T1", patch: {} }),
    ).toThrow(McpError);

    db.close();
  });
});
