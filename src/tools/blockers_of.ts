import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { ticketExists } from "../lib/relations.js";
import { walkRelations } from "../lib/graph.js";
import type { Tool } from "./types.js";

export interface BlockersOfArgs {
  project?: string;
  id: string;
  depth?: number;
}

interface BlockerItem {
  id: string;
  title: string;
  status: string;
  depth: number;
}

export interface BlockersOfResult {
  id: string;
  blockers: BlockerItem[];
}

const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 3;

export function makeBlockersOfTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<BlockersOfArgs, BlockersOfResult> {
  return {
    name: "tickets.blockers_of",
    description:
      "Return all tickets that block a given ticket, traversed recursively (incoming 'blocks' edges). " +
      "Returns the structural blocker tree regardless of blocker status. " +
      "depth default 2, max 3. Results are flat, ordered by depth then id.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        id: { type: "string" },
        depth: { type: "number" },
      },
      required: ["id"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): BlockersOfArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      if (typeof r["id"] !== "string" || r["id"].trim() === "") {
        throw new McpError(ErrorCode.InvalidParams, "id is required.");
      }

      let depth = DEFAULT_DEPTH;
      if (r["depth"] !== undefined) {
        depth = Number(r["depth"]);
        if (!Number.isInteger(depth) || depth < 1) {
          throw new McpError(ErrorCode.InvalidParams, "depth must be a positive integer.");
        }
        depth = Math.min(depth, MAX_DEPTH);
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        id: r["id"] as string,
        depth,
      };
    },

    async handle(args: BlockersOfArgs): Promise<BlockersOfResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;

      if (!ticketExists(db, projectId, args.id)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Ticket ${projectId}/${args.id} not found.`,
        );
      }

      const nodes = walkRelations(db, {
        projectId,
        startId: args.id,
        kinds: ["blocks"],
        direction: "incoming",
        maxDepth: args.depth ?? DEFAULT_DEPTH,
      });

      // Enrich with title + status in one batch.
      const allIds = nodes.map((n) => n.id);
      const enrichMap = fetchTitleStatus(db, projectId, allIds);

      const blockers: BlockerItem[] = nodes
        .map((node) => {
          const enrich = enrichMap.get(node.id) ?? { title: node.id, status: "unknown" };
          return { id: node.id, title: enrich.title, status: enrich.status, depth: node.depth };
        })
        .sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));

      return { id: args.id, blockers };
    },
  };
}

function fetchTitleStatus(
  db: Database.Database,
  projectId: string,
  ids: string[],
): Map<string, { title: string; status: string }> {
  const result = new Map<string, { title: string; status: string }>();
  if (ids.length === 0) return result;

  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, title, status FROM tickets WHERE project_id = ? AND id IN (${placeholders})`,
    )
    .all(projectId, ...ids) as Array<{ id: string; title: string; status: string }>;

  for (const row of rows) {
    result.set(row.id, { title: row.title, status: row.status });
  }
  return result;
}
