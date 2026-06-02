import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeAddTool } from "./add.js";
import { makeLinkTool } from "./link.js";
import { makeUnlinkTool } from "./unlink.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-unlink-test-"));
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
  const unlinkTool = makeUnlinkTool(db);

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

  return { db, addTicket, linkTool, unlinkTool, auditRows };
}

describe("tickets.unlink", () => {
  it("removes existing relation + writes correct audit row", async () => {
    const { db, addTicket, linkTool, unlinkTool, auditRows } = setup();
    const { ticket: t1 } = await addTicket("T1");
    const { ticket: t2 } = await addTicket("T2");

    await linkTool.handle(
      linkTool.parseArgs({ project: "proj1", from: t1.id, to: t2.id, kind: "blocks" }),
    );

    const result = await unlinkTool.handle(
      unlinkTool.parseArgs({ project: "proj1", from: t1.id, to: t2.id, kind: "blocks" }),
    );
    expect(result.removed).toBe(true);

    // Verify relation is gone from DB.
    const relRow = db
      .prepare(
        "SELECT * FROM relations WHERE project_id = ? AND from_id = ? AND to_id = ? AND kind = ?",
      )
      .get("proj1", t1.id, t2.id, "blocks");
    expect(relRow).toBeUndefined();

    // Verify audit row: old_value = from->to, new_value = null.
    const rows = auditRows(t1.id);
    // 1 row from link (relation:blocks add), 1 from unlink (relation:blocks remove)
    expect(rows).toHaveLength(2);
    const unlinkAudit = rows[1]!;
    expect(unlinkAudit.field).toBe("relation:blocks");
    expect(unlinkAudit.old_value).toBe(`${t1.id}->${t2.id}`);
    expect(unlinkAudit.new_value).toBeNull();
    db.close();
  });

  it("unlink non-existent relation → InvalidParams", async () => {
    const { db, addTicket, unlinkTool } = setup();
    const { ticket: t1 } = await addTicket("T1");
    const { ticket: t2 } = await addTicket("T2");

    await expect(
      unlinkTool.handle(
        unlinkTool.parseArgs({ project: "proj1", from: t1.id, to: t2.id, kind: "blocks" }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });
});
