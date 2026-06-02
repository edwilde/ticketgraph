import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeAddTool } from "./add.js";
import { makeAddTagTool } from "./add_tag.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-add-tag-test-"));
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

  async function addTicket(title = "Test ticket") {
    const r = await addTool.handle(addTool.parseArgs({ project: "proj1", title, full: true }));
    if (!("ticket" in r)) throw new Error("expected full add result");
    return r;
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

  return { db, addTicket, addTagTool, auditRows };
}

describe("tickets.add_tag", () => {
  it("normalises tag (trim + lowercase) and writes 1 audit row", async () => {
    const { db, addTicket, addTagTool, auditRows } = setup();
    const { ticket } = await addTicket("T1");

    const result = await addTagTool.handle(
      addTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "  FTS  " }),
    );

    expect(result.tags).toContain("fts");

    const rows = auditRows(ticket.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.field).toBe("tag");
    expect(rows[0]!.old_value).toBeNull();
    expect(rows[0]!.new_value).toBe("fts");
    db.close();
  });

  it("duplicate add_tag → no-op, no second audit row, tag list unchanged", async () => {
    const { db, addTicket, addTagTool, auditRows } = setup();
    const { ticket } = await addTicket("T1");

    await addTagTool.handle(
      addTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "urgent" }),
    );

    const result = await addTagTool.handle(
      addTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "urgent" }),
    );

    // Tag list unchanged (still just 1 entry).
    expect(result.tags).toEqual(["urgent"]);

    // Only 1 audit row (not 2).
    const rows = auditRows(ticket.id);
    expect(rows).toHaveLength(1);
    db.close();
  });

  it("returned tag list is sorted and normalised", async () => {
    const { db, addTicket, addTagTool } = setup();
    const { ticket } = await addTicket("T1");

    await addTagTool.handle(
      addTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "Zebra" }),
    );
    const result = await addTagTool.handle(
      addTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "Alpha" }),
    );

    expect(result.tags).toEqual(["alpha", "zebra"]);
    db.close();
  });

  it("empty tag after normalisation → InvalidParams", async () => {
    const { db, addTicket, addTagTool } = setup();
    const { ticket } = await addTicket("T1");

    await expect(
      addTagTool.handle(
        addTagTool.parseArgs({ project: "proj1", id: ticket.id, tag: "   " }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });

  it("non-existent ticket → InvalidParams", async () => {
    const { db, addTagTool } = setup();

    await expect(
      addTagTool.handle(
        addTagTool.parseArgs({ project: "proj1", id: "NO-SUCH", tag: "urgent" }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });
});
