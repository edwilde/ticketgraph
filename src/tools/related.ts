import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { ticketExists } from "../lib/relations.js";
import { walkRelations } from "../lib/graph.js";
import type { Tool } from "./types.js";

export interface RelatedArgs {
  project?: string;
  id: string;
  kinds?: string[];
  depth?: number;
}

interface RelatedItem {
  id: string;
  title: string;
  status: string;
  note: string | null;
  depth: number;
}

export interface RelatedResult {
  id: string;
  outgoing: Record<string, RelatedItem[]>;
  incoming: Record<string, RelatedItem[]>;
}

const DEFAULT_DEPTH = 1;
const MAX_DEPTH = 3;

export function makeRelatedTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<RelatedArgs, RelatedResult> {
  return {
    name: "tickets.related",
    description:
      "Find all tickets related to a given ticket, in both directions, grouped by direction and kind. " +
      "depth controls traversal hops (default 1, max 3). " +
      "Optional kinds filter restricts to specific relation kinds.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        id: { type: "string" },
        kinds: { type: "array", items: { type: "string" } },
        depth: { type: "number" },
      },
      required: ["id"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): RelatedArgs {
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

      let kinds: string[] | undefined;
      if (r["kinds"] !== undefined) {
        if (!Array.isArray(r["kinds"])) {
          throw new McpError(ErrorCode.InvalidParams, "kinds must be an array.");
        }
        kinds = r["kinds"] as string[];
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        id: r["id"] as string,
        kinds,
        depth,
      };
    },

    async handle(args: RelatedArgs): Promise<RelatedResult> {
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
        kinds: args.kinds,
        direction: "both",
        maxDepth: args.depth ?? DEFAULT_DEPTH,
      });

      // Collect all unique ids for enrichment.
      const allIds = [...new Set(nodes.map((n) => n.id))];
      const enrichMap = fetchTitleStatus(db, projectId, allIds);

      const outgoing: Record<string, RelatedItem[]> = {};
      const incoming: Record<string, RelatedItem[]> = {};

      for (const node of nodes) {
        const enrich = enrichMap.get(node.id) ?? { title: node.id, status: "unknown" };
        const item: RelatedItem = {
          id: node.id,
          title: enrich.title,
          status: enrich.status,
          note: node.note,
          depth: node.depth,
        };

        if (node.direction === "outgoing") {
          if (!outgoing[node.kind]) outgoing[node.kind] = [];
          outgoing[node.kind]!.push(item);
        } else {
          if (!incoming[node.kind]) incoming[node.kind] = [];
          incoming[node.kind]!.push(item);
        }
      }

      return { id: args.id, outgoing, incoming };
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
