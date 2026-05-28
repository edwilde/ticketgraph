import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { makeAddTool } from "./add.js";
import { makeAddTagTool } from "./add_tag.js";
import { makeRemoveTagTool } from "./remove_tag.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-remove-tag-test-"));
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
  const addTagTool = makeAddTagTool(db);
  const removeTagTool = makeRemoveTagTool(db);

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

  return { db, addTicket, addTagTool, removeTagTool, auditRows };
}

describe("tickets.remove_tag", () => {
  it("removes present tag + writes 1 audit row", async () => {
    const { db, addTicket, addTagTool, removeTagTool, auditRows } = setup();
    const { ticket } = await addTicket("T1");

    await addTagTool.handle(
      addTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "urgent" }),
    );

    const result = await removeTagTool.handle(
      removeTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "urgent" }),
    );

    expect(result.tags).not.toContain("urgent");
    expect(result.tags).toHaveLength(0);

    const rows = auditRows(ticket.id);
    // 1 add audit + 1 remove audit = 2 total
    expect(rows).toHaveLength(2);
    const removeAudit = rows[1]!;
    expect(removeAudit.field).toBe("tag");
    expect(removeAudit.old_value).toBe("urgent");
    expect(removeAudit.new_value).toBeNull();
    db.close();
  });

  it("remove absent tag → no-op, no audit row, no error", async () => {
    const { db, addTicket, removeTagTool, auditRows } = setup();
    const { ticket } = await addTicket("T1");

    const result = await removeTagTool.handle(
      removeTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "nonexistent" }),
    );

    expect(result.tags).toHaveLength(0);
    const rows = auditRows(ticket.id);
    expect(rows).toHaveLength(0);
    db.close();
  });

  it("non-existent ticket → InvalidParams", async () => {
    const { db, removeTagTool } = setup();
    await expect(
      removeTagTool.handle(
        removeTagTool.parseArgs({ project: "proj1", id: "T999", tag: "urgent" }),
      ),
    ).rejects.toThrow(/not found/);
    db.close();
  });

  it("normalises tag before matching (remove 'URGENT' removes 'urgent')", async () => {
    const { db, addTicket, addTagTool, removeTagTool } = setup();
    const { ticket } = await addTicket("T1");

    await addTagTool.handle(
      addTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "urgent" }),
    );

    const result = await removeTagTool.handle(
      removeTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "URGENT" }),
    );

    expect(result.tags).not.toContain("urgent");
    expect(result.tags).toHaveLength(0);
    db.close();
  });

  it("returned tag list is sorted after removal", async () => {
    const { db, addTicket, addTagTool, removeTagTool } = setup();
    const { ticket } = await addTicket("T1");

    await addTagTool.handle(
      addTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "alpha" }),
    );
    await addTagTool.handle(
      addTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "beta" }),
    );
    await addTagTool.handle(
      addTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "gamma" }),
    );

    const result = await removeTagTool.handle(
      removeTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "beta" }),
    );

    expect(result.tags).toEqual(["alpha", "gamma"]);
    db.close();
  });
});
