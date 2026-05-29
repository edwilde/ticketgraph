import type Database from "better-sqlite3";
import { nowIso } from "./now.js";

export interface WriteAuditParams {
  projectId: string;
  ticketId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt?: string;
}

/**
 * Write a single audit_log row. Returns the inserted row id.
 * changedAt defaults to nowIso() when omitted.
 */
export function writeAudit(db: Database.Database, params: WriteAuditParams): number {
  const changedAt = params.changedAt ?? nowIso();
  const result = db
    .prepare(
      `INSERT INTO audit_log (project_id, ticket_id, field, old_value, new_value, changed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(params.projectId, params.ticketId, params.field, params.oldValue, params.newValue, changedAt);
  return Number(result.lastInsertRowid);
}
