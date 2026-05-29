import type Database from "better-sqlite3";

export const KNOWN_RELATION_KINDS = ["blocks", "follows_up", "supersedes", "relates_to"] as const;
export type RelationKind = (typeof KNOWN_RELATION_KINDS)[number];

export function isKnownKind(kind: string): kind is RelationKind {
  return (KNOWN_RELATION_KINDS as readonly string[]).includes(kind);
}

/**
 * Returns true if a ticket with the given id exists in the given project.
 */
export function ticketExists(
  db: Database.Database,
  projectId: string,
  id: string,
): boolean {
  const row = db
    .prepare("SELECT 1 FROM tickets WHERE project_id = ? AND id = ?")
    .get(projectId, id);
  return row !== undefined;
}
