import type Database from "better-sqlite3";

export type RelationDirection = "incoming" | "outgoing" | "both";

export interface WalkRelationsOpts {
  projectId: string;
  startId: string;
  kinds?: string[];
  direction: RelationDirection;
  maxDepth: number;
}

export interface WalkRelationNode {
  id: string;
  kind: string;
  note: string | null;
  depth: number;
  direction: "incoming" | "outgoing";
}

interface RelationEdge {
  from_id: string;
  to_id: string;
  kind: string;
  note: string | null;
}

/**
 * BFS traversal over the relations graph.
 * Returns nodes reachable from startId (startId itself is NOT included).
 * Uses a visited-set keyed by id to prevent cycles (e.g. symmetric relates_to).
 */
export function walkRelations(
  db: Database.Database,
  opts: WalkRelationsOpts,
): WalkRelationNode[] {
  const { projectId, startId, kinds, direction, maxDepth } = opts;

  const results: WalkRelationNode[] = [];
  const visited = new Set<string>([startId]);

  // Queue entries: [currentId, depth]
  const queue: Array<[string, number]> = [[startId, 0]];

  const stmtOut = db.prepare<[string, string]>(
    "SELECT from_id, to_id, kind, note FROM relations WHERE project_id = ? AND from_id = ?",
  );
  const stmtIn = db.prepare<[string, string]>(
    "SELECT from_id, to_id, kind, note FROM relations WHERE project_id = ? AND to_id = ?",
  );

  while (queue.length > 0) {
    const [currentId, currentDepth] = queue.shift()!;
    if (currentDepth >= maxDepth) continue;

    const nextDepth = currentDepth + 1;

    const edges: Array<{ edge: RelationEdge; edgeDir: "outgoing" | "incoming" }> = [];

    if (direction === "outgoing" || direction === "both") {
      const rows = stmtOut.all(projectId, currentId) as RelationEdge[];
      for (const row of rows) {
        edges.push({ edge: row, edgeDir: "outgoing" });
      }
    }
    if (direction === "incoming" || direction === "both") {
      const rows = stmtIn.all(projectId, currentId) as RelationEdge[];
      for (const row of rows) {
        edges.push({ edge: row, edgeDir: "incoming" });
      }
    }

    for (const { edge, edgeDir } of edges) {
      // Filter by kinds if provided.
      if (kinds && kinds.length > 0 && !kinds.includes(edge.kind)) continue;

      const neighborId = edgeDir === "outgoing" ? edge.to_id : edge.from_id;
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);

      results.push({
        id: neighborId,
        kind: edge.kind,
        note: edge.note,
        depth: nextDepth,
        direction: edgeDir,
      });

      queue.push([neighborId, nextDepth]);
    }
  }

  return results;
}

export interface WalkChildrenOpts {
  projectId: string;
  parentId: string;
  maxDepth: number;
}

export interface WalkChildNode {
  id: string;
  parent_id: string;
  depth: number;
}

/**
 * BFS traversal downward over parent_id links.
 * Returns all descendants of parentId (parentId itself is NOT included).
 * Uses a visited-set to guard against malformed cycles.
 */
export function walkChildren(
  db: Database.Database,
  opts: WalkChildrenOpts,
): WalkChildNode[] {
  const { projectId, parentId, maxDepth } = opts;

  const results: WalkChildNode[] = [];
  const visited = new Set<string>([parentId]);

  const queue: Array<[string, number]> = [[parentId, 0]];

  const stmt = db.prepare<[string, string]>(
    "SELECT id FROM tickets WHERE project_id = ? AND parent_id = ?",
  );

  while (queue.length > 0) {
    const [currentId, currentDepth] = queue.shift()!;
    if (currentDepth >= maxDepth) continue;

    const nextDepth = currentDepth + 1;

    const children = stmt.all(projectId, currentId) as Array<{ id: string }>;
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);

      results.push({ id: child.id, parent_id: currentId, depth: nextDepth });
      queue.push([child.id, nextDepth]);
    }
  }

  return results;
}
