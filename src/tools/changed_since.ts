import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import type { Tool } from "./types.js";

export interface ChangedSinceArgs {
  project?: string;
  since: string;
  field?: string;
  new_value?: string;
  limit?: number;
}

interface ChangeRow {
  ticket_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
}

export interface ChangedSinceResult {
  project: string;
  count: number;
  changes: ChangeRow[];
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function makeChangedSinceTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<ChangedSinceArgs, ChangedSinceResult> {
  return {
    name: "tickets.changed_since",
    description:
      "Slice the audit log for changes since a given ISO timestamp. " +
      "'since' is required (ISO date or datetime). " +
      "Optional 'field' and 'new_value' filters narrow results. " +
      "Default limit 100, max 500. Sorted changed_at DESC.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        since: { type: "string" },
        field: { type: "string" },
        new_value: { type: "string" },
        limit: { type: "number" },
      },
      required: ["since"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): ChangedSinceArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      if (typeof r["since"] !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "since is required and must be a string.");
      }
      const since = r["since"] as string;
      if (isNaN(new Date(since).getTime())) {
        throw new McpError(ErrorCode.InvalidParams, `since '${since}' is not a valid ISO date/datetime.`);
      }

      let limit = DEFAULT_LIMIT;
      if (r["limit"] !== undefined) {
        limit = Number(r["limit"]);
        if (!Number.isInteger(limit) || limit < 1) {
          throw new McpError(ErrorCode.InvalidParams, "limit must be a positive integer.");
        }
        limit = Math.min(limit, MAX_LIMIT);
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        since,
        field: typeof r["field"] === "string" ? r["field"] : undefined,
        new_value: typeof r["new_value"] === "string" ? r["new_value"] : undefined,
        limit,
      };
    },

    async handle(args: ChangedSinceArgs): Promise<ChangedSinceResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;

      const conditions: string[] = ["project_id = ?", "changed_at >= ?"];
      const params: unknown[] = [projectId, args.since];

      if (args.field !== undefined) {
        conditions.push("field = ?");
        params.push(args.field);
      }
      if (args.new_value !== undefined) {
        conditions.push("new_value = ?");
        params.push(args.new_value);
      }

      const whereStr = conditions.join(" AND ");
      const sql =
        `SELECT ticket_id, field, old_value, new_value, changed_at ` +
        `FROM audit_log WHERE ${whereStr} ` +
        `ORDER BY changed_at DESC LIMIT ?`;

      params.push(args.limit ?? DEFAULT_LIMIT);

      const changes = db.prepare(sql).all(params) as ChangeRow[];

      return {
        project: projectId,
        count: changes.length,
        changes,
      };
    },
  };
}
