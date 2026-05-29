import type Database from "better-sqlite3";

/**
 * Detect whether setting ticketId's parent to newParentId would create a cycle.
 *
 * Walks the parent_id chain from newParentId upward. If ticketId is encountered,
 * returning true (a cycle would form). If parent_id becomes null, returns false.
 *
 * Hard cap at 100 hops guards against pre-existing cycles in the DB.
 */
export function wouldCreateCycle(
  db: Database.Database,
  {
    projectId,
    ticketId,
    newParentId,
  }: { projectId: string; ticketId: string; newParentId: string },
): boolean {
  const stmt = db.prepare(
    "SELECT parent_id FROM tickets WHERE project_id = ? AND id = ?",
  );

  let current: string = newParentId;
  let hops = 0;
  const MAX_HOPS = 100;

  while (hops < MAX_HOPS) {
    if (current === ticketId) {
      return true;
    }

    const row = stmt.get(projectId, current) as { parent_id: string | null } | undefined;
    if (!row) {
      // Ticket doesn't exist — no cycle possible from here.
      return false;
    }

    if (row.parent_id === null) {
      return false;
    }

    current = row.parent_id;
    hops++;
  }

  // Exceeded hop limit — the DB has a pre-existing cycle.
  throw new Error(
    `Cycle detection exceeded ${MAX_HOPS} hops — the database may contain a pre-existing cycle.`,
  );
}
