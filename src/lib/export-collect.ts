import type Database from "better-sqlite3";
import type { TicketRecord, TicketRelations } from "./export-markdown.js";

interface TicketRow {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string | null;
  type: string;
  effort: number | null;
  epic: string | null;
}

interface TagRow {
  ticket_id: string;
  tag: string;
}

interface RelationRow {
  from_id: string;
  to_id: string;
  kind: string;
  note: string | null;
}

interface StatusCountRow {
  status: string;
  cnt: number;
}

export function collectProjectExport(
  db: Database.Database,
  projectId: string,
): { tickets: TicketRecord[]; statusCounts: Record<string, number> } {
  // Fetch all tickets with explicit columns, ordered by priority rank then id.
  const ticketRows = db
    .prepare(
      `SELECT id, title, description, status, priority, type, effort, epic
       FROM tickets
       WHERE project_id = ?
       ORDER BY (CASE priority
         WHEN 'P0' THEN 0
         WHEN 'P1' THEN 1
         WHEN 'P2' THEN 2
         WHEN 'P3' THEN 3
         ELSE 4
       END), id ASC`,
    )
    .all(projectId) as TicketRow[];

  // Fetch all tags for the project.
  const tagRows = db
    .prepare("SELECT ticket_id, tag FROM tags WHERE project_id = ?")
    .all(projectId) as TagRow[];

  // Fetch all relations for the project.
  const relRows = db
    .prepare(
      "SELECT from_id, to_id, kind, note FROM relations WHERE project_id = ?",
    )
    .all(projectId) as RelationRow[];

  // Fetch status counts.
  const statusCountRows = db
    .prepare(
      "SELECT status, COUNT(*) as cnt FROM tickets WHERE project_id = ? GROUP BY status",
    )
    .all(projectId) as StatusCountRow[];

  // Build tag map keyed by ticket id.
  const tagMap = new Map<string, string[]>();
  for (const row of tagRows) {
    let tags = tagMap.get(row.ticket_id);
    if (!tags) {
      tags = [];
      tagMap.set(row.ticket_id, tags);
    }
    tags.push(row.tag);
  }

  // Build relation maps keyed by ticket id.
  const outgoingMap = new Map<string, Record<string, Array<{ id: string; note: string | null }>>>();
  const incomingMap = new Map<string, Record<string, Array<{ id: string; note: string | null }>>>();

  for (const rel of relRows) {
    // outgoing side (from_id)
    if (!outgoingMap.has(rel.from_id)) outgoingMap.set(rel.from_id, {});
    const outgoing = outgoingMap.get(rel.from_id)!;
    if (!outgoing[rel.kind]) outgoing[rel.kind] = [];
    outgoing[rel.kind]!.push({ id: rel.to_id, note: rel.note });

    // incoming side (to_id) — skip for self-loops to match get.ts semantics
    // (a self-loop lands in outgoing only, same as: if (from_id === ticketId) outgoing; else incoming)
    if (rel.from_id !== rel.to_id) {
      if (!incomingMap.has(rel.to_id)) incomingMap.set(rel.to_id, {});
      const incoming = incomingMap.get(rel.to_id)!;
      if (!incoming[rel.kind]) incoming[rel.kind] = [];
      incoming[rel.kind]!.push({ id: rel.from_id, note: rel.note });
    }
  }

  // Stitch everything together.
  const tickets: TicketRecord[] = ticketRows.map((row) => {
    const relations: TicketRelations = {
      outgoing: outgoingMap.get(row.id) ?? {},
      incoming: incomingMap.get(row.id) ?? {},
    };
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      type: row.type,
      effort: row.effort,
      epic: row.epic,
      tags: tagMap.get(row.id) ?? [],
      relations,
    };
  });

  // Build status counts map.
  const statusCounts: Record<string, number> = {};
  for (const row of statusCountRows) {
    statusCounts[row.status] = row.cnt;
  }

  return { tickets, statusCounts };
}
