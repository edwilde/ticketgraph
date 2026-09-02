import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ImportTicket, ImportRelation } from "./import-format.js";
import { writeAudit } from "./audit.js";
import { nowIso } from "./now.js";

export interface ImportCounts {
  tickets: number;
  relations: number;
  tags: number;
}

export interface InsertBatchArgs {
  projectId: string;
  tickets: ImportTicket[];
  relations?: ImportRelation[];
  force?: boolean;
  dryRun?: boolean;
}

export interface InsertBatchResult {
  imported?: boolean;
  dry_run?: boolean;
  // inserted ids in input order; consumed by tickets.add_many, discarded by import_json
  created: string[];
  counts: ImportCounts;
  warnings: string[];
}

/**
 * Shared insert core for batch ticket creation.
 *
 * Owns duplicate detection, dangling-relation pre-scan, the dry_run early-return,
 * the abort-on-duplicate-without-force rule, the 3-pass insert transaction, and
 * the post-transaction recount + warning merge. Callers must resolve every
 * ticket id before calling — insertBatch does NO id inference. Project
 * resolution, file reads, and project_id-match assertions are the caller's job.
 */
export function insertBatch(
  db: Database.Database,
  { projectId, tickets, relations = [], force = false, dryRun = false }: InsertBatchArgs,
): InsertBatchResult {
  // Step 1: compute warnings — duplicates and dangling relations.
  const warnings: string[] = [];

  // Find colliding ticket ids.
  const fileIds = new Set(tickets.map((t) => t.id));
  const collidingIds: string[] = [];
  for (const ticket of tickets) {
    const existing = db
      .prepare("SELECT id FROM tickets WHERE project_id = ? AND id = ?")
      .get(projectId, ticket.id);
    if (existing) {
      collidingIds.push(ticket.id);
    }
  }

  if (collidingIds.length > 0) {
    warnings.push(`Duplicate ticket ids (already in DB): ${collidingIds.join(", ")}`);
  }

  // Find dangling relations: endpoints not in file and not in DB.
  const dbIdSet = new Set<string>();
  const dbRows = db
    .prepare("SELECT id FROM tickets WHERE project_id = ?")
    .all(projectId) as Array<{ id: string }>;
  for (const row of dbRows) {
    dbIdSet.add(row.id);
  }
  const allKnownIds = new Set([...fileIds, ...dbIdSet]);

  const danglingRelations: string[] = [];
  for (const rel of relations) {
    if (!allKnownIds.has(rel.from) || !allKnownIds.has(rel.to)) {
      danglingRelations.push(
        `Relation ${rel.from}->${rel.to} (${rel.kind}): endpoint(s) not found — skipped`,
      );
    }
  }
  warnings.push(...danglingRelations);

  // Compute counts.
  const tagCount = tickets.reduce((sum, t) => sum + (t.tags ? t.tags.length : 0), 0);
  const validRelationCount = relations.filter(
    (rel) => allKnownIds.has(rel.from) && allKnownIds.has(rel.to),
  ).length;
  const counts: ImportCounts = {
    tickets: tickets.length,
    relations: validRelationCount,
    tags: tagCount,
  };

  // Step 2: dry_run — return without mutating.
  if (dryRun) {
    return { dry_run: true, created: [], counts, warnings };
  }

  // Step 3: if duplicates exist and !force, abort.
  if (collidingIds.length > 0 && !force) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Import aborted: duplicate ticket ids exist in project '${projectId}': ${collidingIds.join(", ")}. Use force: true to overwrite.`,
    );
  }

  // Step 4: write in ONE transaction — 3 passes.
  const skippedRelationWarnings: string[] = [];
  const created: string[] = [];
  let insertedRelationCount = 0;

  const doImport = db.transaction(() => {
    // Force: delete colliding tickets first (cascades relations/tags).
    // Detach children before each delete: the (project_id, parent_id) FK is
    // ON DELETE SET NULL, and SQLite nulls every column of a composite child
    // key, project_id included, which violates NOT NULL. Children that are
    // themselves in the batch get their parent_id back in pass 2.
    if (force && collidingIds.length > 0) {
      const detachChildren = db.prepare(
        "UPDATE tickets SET parent_id = NULL WHERE project_id = ? AND parent_id = ?",
      );
      const deleteStmt = db.prepare("DELETE FROM tickets WHERE project_id = ? AND id = ?");
      for (const id of collidingIds) {
        detachChildren.run(projectId, id);
        deleteStmt.run(projectId, id);
      }
    }

    // Pass 1: insert all tickets with parent_id = NULL, plus tags + _created audit.
    const insertTicket = db.prepare(
      `INSERT INTO tickets (id, project_id, title, description, status, priority, type, effort, epic, parent_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    );
    const insertTag = db.prepare(
      "INSERT INTO tags (project_id, ticket_id, tag) VALUES (?, ?, ?)",
    );
    const updateClosedAt = db.prepare(
      "UPDATE tickets SET closed_at = ? WHERE project_id = ? AND id = ?",
    );

    for (const ticket of tickets) {
      const created_at = ticket.created_at ?? nowIso();
      const status = ticket.status ?? "open";
      const type = ticket.type ?? "task";
      const description = ticket.description ?? "";
      const created_by = ticket.created_by ?? "claude";

      try {
        insertTicket.run(
          ticket.id,
          projectId,
          ticket.title,
          description,
          status,
          ticket.priority ?? null,
          type,
          ticket.effort ?? null,
          ticket.epic ?? null,
          created_by,
          created_at,
        );
      } catch (err) {
        const msg = String(err);
        if (msg.includes("CHECK constraint failed") || msg.includes("SQLITE_CONSTRAINT_CHECK")) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid field value for ticket ${ticket.id}: ${msg}`,
          );
        }
        throw new McpError(ErrorCode.InvalidParams, `Insert failed for ticket ${ticket.id}: ${msg}`);
      }

      created.push(ticket.id);

      // Insert tags (normalised).
      const tags = ticket.tags ?? [];
      const normalisedTags = [...new Set(tags.map((t) => t.trim().toLowerCase()))].filter(
        (t) => t.length > 0,
      );
      for (const tag of normalisedTags) {
        insertTag.run(projectId, ticket.id, tag);
      }

      // Back-dated _created audit row.
      writeAudit(db, {
        projectId,
        ticketId: ticket.id,
        field: "_created",
        oldValue: null,
        newValue: ticket.id,
        changedAt: created_at,
      });

      // Set closed_at if status is terminal and closed_at is provided.
      if (ticket.closed_at != null) {
        updateClosedAt.run(ticket.closed_at, projectId, ticket.id);
      }
    }

    // Pass 2: update parent_id for tickets that had one.
    const updateParent = db.prepare(
      "UPDATE tickets SET parent_id = ? WHERE project_id = ? AND id = ?",
    );
    for (const ticket of tickets) {
      if (ticket.parent_id != null) {
        updateParent.run(ticket.parent_id, projectId, ticket.id);
      }
    }

    // Pass 3: insert valid relations; skip dangling ones with a warning.
    // Re-compute known ids inside transaction (includes freshly inserted tickets).
    const freshIds = new Set(tickets.map((t) => t.id));
    const existingDbIds = new Set(
      (db
        .prepare("SELECT id FROM tickets WHERE project_id = ?")
        .all(projectId) as Array<{ id: string }>).map((r) => r.id),
    );
    const allIds = new Set([...freshIds, ...existingDbIds]);

    const insertRelation = db.prepare(
      `INSERT OR IGNORE INTO relations (project_id, from_id, to_id, kind, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const now = nowIso();
    for (const rel of relations) {
      if (!allIds.has(rel.from) || !allIds.has(rel.to)) {
        skippedRelationWarnings.push(
          `Relation ${rel.from}->${rel.to} (${rel.kind}): endpoint(s) not found — skipped`,
        );
        continue;
      }
      const info = insertRelation.run(projectId, rel.from, rel.to, rel.kind, rel.note ?? null, now);
      insertedRelationCount += info.changes;
      writeAudit(db, {
        projectId,
        ticketId: rel.from,
        field: `relation:${rel.kind}`,
        oldValue: null,
        newValue: `${rel.from}->${rel.to}`,
        changedAt: now,
      });
    }
  });

  doImport();

  // Merge skipped-relation warnings captured inside the transaction.
  // (Remove the pre-computed dangling warnings which were based on pre-import DB state,
  //  replace with the authoritative ones from inside the transaction.)
  // NOTE: the "— skipped" suffix uses a non-ASCII em-dash (—) and MUST match the dangling-
  // relation warning strings produced by the danglingRelations loop and skippedRelationWarnings
  // above. If those message formats change, this filter predicate must change too.
  const finalWarnings = warnings.filter(
    (w) => !w.startsWith("Relation ") || !w.endsWith("— skipped"),
  );
  finalWarnings.push(...skippedRelationWarnings);

  // Recount actual tags inserted (after normalisation/dedup).
  const actualTagCount = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM tags WHERE project_id = ? AND ticket_id IN (${tickets.map(() => "?").join(",")})`,
      )
      .get(projectId, ...tickets.map((t) => t.id)) as { n: number }
  ).n;

  return {
    imported: true,
    created,
    counts: {
      tickets: tickets.length,
      relations: insertedRelationCount,
      tags: actualTagCount,
    },
    warnings: finalWarnings,
  };
}
