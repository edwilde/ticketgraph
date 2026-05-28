import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../db.js";
import { makeAddTool } from "./add.js";
import { makeAppendToDescriptionTool } from "./append_to_description.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ticketgraph-append-test-"));
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
  const appendTool = makeAppendToDescriptionTool(db);

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

  return { db, addTicket, appendTool, auditRows };
}

describe("tickets.append_to_description", () => {
  it("append to empty description → description === text, no leading separator", async () => {
    const { db, addTicket, appendTool } = setup();
    const { ticket } = await addTicket("T1");
    expect(ticket.description).toBe("");

    const result = await appendTool.handle(
      appendTool.parseArgs({ project: "proj1", id: ticket.id, text: "first chunk" }),
    );

    expect(result.ticket.description).toBe("first chunk");
    db.close();
  });

  it("append to non-empty description → old + default separator + new", async () => {
    const { db, addTicket, appendTool } = setup();
    const { ticket } = await addTicket("T1", { description: "original body" });

    const result = await appendTool.handle(
      appendTool.parseArgs({ project: "proj1", id: ticket.id, text: "appended chunk" }),
    );

    expect(result.ticket.description).toBe("original body\n\nappended chunk");
    db.close();
  });

  it("custom separator is honoured", async () => {
    const { db, addTicket, appendTool } = setup();
    const { ticket } = await addTicket("T1", { description: "part one" });

    const result = await appendTool.handle(
      appendTool.parseArgs({
        project: "proj1",
        id: ticket.id,
        text: "part two",
        separator: "\n---\n",
      }),
    );

    expect(result.ticket.description).toBe("part one\n---\npart two");
    db.close();
  });

  it("audit row new_value === appended chunk only (not full description)", async () => {
    const { db, addTicket, appendTool, auditRows } = setup();
    const { ticket } = await addTicket("T1", { description: "existing text" });

    await appendTool.handle(
      appendTool.parseArgs({ project: "proj1", id: ticket.id, text: "just the chunk" }),
    );

    const rows = auditRows(ticket.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.field).toBe("description:append");
    expect(rows[0]!.old_value).toBeNull();
    expect(rows[0]!.new_value).toBe("just the chunk");
    db.close();
  });

  it("FTS reflects the appended text (MATCH on word only in chunk)", async () => {
    const { db, addTicket, appendTool } = setup();
    const { ticket } = await addTicket("T1", { description: "initial content" });

    await appendTool.handle(
      appendTool.parseArgs({
        project: "proj1",
        id: ticket.id,
        text: "xyzuniqueftsword",
      }),
    );

    const ftsRow = db
      .prepare(
        "SELECT ticket_id FROM tickets_fts WHERE tickets_fts MATCH ? AND project_id = ?",
      )
      .get("xyzuniqueftsword", "proj1") as { ticket_id: string } | undefined;

    expect(ftsRow).toBeDefined();
    expect(ftsRow!.ticket_id).toBe(ticket.id);
    db.close();
  });

  it("empty text → InvalidParams", async () => {
    const { db, addTicket, appendTool } = setup();
    const { ticket } = await addTicket("T1");

    expect(() =>
      appendTool.parseArgs({ project: "proj1", id: ticket.id, text: "" }),
    ).toThrow(McpError);
    db.close();
  });

  it("non-existent ticket → InvalidParams", async () => {
    const { db, appendTool } = setup();

    await expect(
      appendTool.handle(
        appendTool.parseArgs({ project: "proj1", id: "NO-SUCH", text: "chunk" }),
      ),
    ).rejects.toThrow(McpError);
    db.close();
  });
});
