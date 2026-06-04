import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import type { Tool } from "./types.js";

const DEFAULT_STATUS_FILTER = ["open", "in_progress", "blocked"];
const VALID_STATUSES = new Set(["open", "in_progress", "blocked", "done", "deferred"]);
// Sentinels accepted in addition to the concrete statuses (see handle()).
const STATUS_SENTINELS = new Set(["all", "outstanding"]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface ListArgs {
  project?: string;
  status?: string | string[];
  priority?: string;
  type?: string;
  epic?: string;
  parent_id?: string | null;
  tag?: string;
  blocked_by?: string;
  created_after?: string;
  include_description?: boolean;
  limit?: number;
  offset?: number;
}

export interface ListResult {
  project: string;
  count: number;
  rows: unknown[];
}

export function makeListTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<ListArgs, ListResult> {
  return {
    name: "tickets.list",
    description:
      "List tickets with optional filters. Default status filter: open, in_progress, blocked. " +
      "Pass status: 'all' for every status, or 'outstanding' for everything not done. " +
      "Default limit 50 (max 200).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        status: {
          description:
            "open/in_progress/blocked (default), or 'all', or 'outstanding' (everything not done)",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        priority: { type: "string" },
        type: { type: "string" },
        epic: { type: "string" },
        parent_id: { type: "string", nullable: true },
        tag: { type: "string" },
        blocked_by: { type: "string" },
        created_after: { type: "string" },
        include_description: { type: "boolean" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      additionalProperties: false,
    },

    parseArgs(raw: unknown): ListArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      const limit = r["limit"] !== undefined ? Number(r["limit"]) : DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1) {
        throw new McpError(ErrorCode.InvalidParams, "limit must be a positive integer.");
      }
      if (limit > MAX_LIMIT) {
        throw new McpError(ErrorCode.InvalidParams, `limit cannot exceed ${MAX_LIMIT}.`);
      }

      const offset = r["offset"] !== undefined ? Number(r["offset"]) : 0;
      if (!Number.isInteger(offset) || offset < 0) {
        throw new McpError(ErrorCode.InvalidParams, "offset must be a non-negative integer.");
      }

      // Validate status: a string must be a known status or a sentinel
      // (all/outstanding); an array must contain only known statuses. This
      // closes a footgun where a typo (e.g. "outstandng") silently matched
      // zero rows instead of failing loudly.
      const statusRaw = r["status"];
      if (typeof statusRaw === "string") {
        if (!VALID_STATUSES.has(statusRaw) && !STATUS_SENTINELS.has(statusRaw)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `status must be one of: ${[...VALID_STATUSES, ...STATUS_SENTINELS].join(", ")} (got '${statusRaw}')`,
          );
        }
      } else if (Array.isArray(statusRaw)) {
        for (const s of statusRaw) {
          if (typeof s !== "string" || !VALID_STATUSES.has(s)) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `status array must contain only: ${[...VALID_STATUSES].join(", ")} (got '${String(s)}')`,
            );
          }
        }
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        status: statusRaw as string | string[] | undefined,
        priority: typeof r["priority"] === "string" ? r["priority"] : undefined,
        type: typeof r["type"] === "string" ? r["type"] : undefined,
        epic: typeof r["epic"] === "string" ? r["epic"] : undefined,
        parent_id: (r["parent_id"] as string | null | undefined) ?? undefined,
        tag: typeof r["tag"] === "string" ? r["tag"] : undefined,
        blocked_by: typeof r["blocked_by"] === "string" ? r["blocked_by"] : undefined,
        created_after: typeof r["created_after"] === "string" ? r["created_after"] : undefined,
        include_description: typeof r["include_description"] === "boolean" ? r["include_description"] : undefined,
        limit,
        offset,
      };
    },

    async handle(args: ListArgs): Promise<ListResult> {
      const project = await requireProject(db, { project: args.project, allowAll: true }, getClientRoots);
      const isAll = project.id === "all";

      const whereClauses: string[] = [];
      const whereParams: unknown[] = [];
      const joinParams: unknown[] = [];

      // Project filter.
      if (!isAll) {
        whereClauses.push("t.project_id = ?");
        whereParams.push(project.id);
      }

      // Status filter.
      const statusArg = args.status;
      if (statusArg === "all") {
        // No status filter.
      } else if (statusArg === "outstanding") {
        // "outstanding" = everything not done. Implemented as != 'done'
        // rather than the spec's enumerated open/in_progress/blocked/deferred:
        // under the closed 5-status enum the two are equivalent, and != 'done'
        // is superset-safe if a new non-terminal status is ever added.
        whereClauses.push("t.status != 'done'");
      } else if (Array.isArray(statusArg) && statusArg.length > 0) {
        const placeholders = statusArg.map(() => "?").join(", ");
        whereClauses.push(`t.status IN (${placeholders})`);
        whereParams.push(...statusArg);
      } else if (typeof statusArg === "string") {
        whereClauses.push("t.status = ?");
        whereParams.push(statusArg);
      } else {
        // Default filter: open, in_progress, blocked.
        const placeholders = DEFAULT_STATUS_FILTER.map(() => "?").join(", ");
        whereClauses.push(`t.status IN (${placeholders})`);
        whereParams.push(...DEFAULT_STATUS_FILTER);
      }

      if (args.priority !== undefined) {
        whereClauses.push("t.priority = ?");
        whereParams.push(args.priority);
      }
      if (args.type !== undefined) {
        whereClauses.push("t.type = ?");
        whereParams.push(args.type);
      }
      if (args.epic !== undefined) {
        whereClauses.push("t.epic = ?");
        whereParams.push(args.epic);
      }
      if (args.parent_id !== undefined) {
        if (args.parent_id === null) {
          whereClauses.push("t.parent_id IS NULL");
        } else {
          whereClauses.push("t.parent_id = ?");
          whereParams.push(args.parent_id);
        }
      }
      if (args.created_after !== undefined) {
        whereClauses.push("t.created_at > ?");
        whereParams.push(args.created_after);
      }

      // Tag JOIN — param comes before WHERE params.
      let tagJoin = "";
      if (args.tag !== undefined) {
        tagJoin = "INNER JOIN tags tg ON tg.project_id = t.project_id AND tg.ticket_id = t.id AND tg.tag = ?";
        joinParams.push(args.tag);
      }

      // blocked_by JOIN — param comes before WHERE params.
      let blockedByJoin = "";
      if (args.blocked_by !== undefined) {
        blockedByJoin =
          "INNER JOIN relations r ON r.project_id = t.project_id AND r.to_id = t.id AND r.kind = 'blocks' AND r.from_id = ?";
        joinParams.push(args.blocked_by);
      }

      const whereStr = whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";
      const joinStr = [tagJoin, blockedByJoin].filter(Boolean).join(" ");

      // All params: join params first, then where params.
      const allParams = [...joinParams, ...whereParams];

      const columns = args.include_description
        ? "t.id, t.project_id, t.title, t.description, t.status, t.priority, t.type, t.effort, t.epic, t.parent_id, t.created_at, t.closed_at"
        : "t.id, t.project_id, t.title, t.status, t.priority, t.type, t.effort, t.epic, t.parent_id, t.created_at, t.closed_at";

      const countSql = `SELECT COUNT(*) as cnt FROM tickets t ${joinStr} ${whereStr}`;
      const rowsSql = `SELECT ${columns} FROM tickets t ${joinStr} ${whereStr} ORDER BY t.priority ASC NULLS LAST, t.id ASC LIMIT ? OFFSET ?`;

      const limit = args.limit ?? DEFAULT_LIMIT;
      const offset = args.offset ?? 0;

      const countResult = db.prepare(countSql).get(allParams) as { cnt: number };
      const count = countResult.cnt;
      const rows = db.prepare(rowsSql).all([...allParams, limit, offset]);

      return {
        project: project.id,
        count,
        rows,
      };
    },
  };
}
