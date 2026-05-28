import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import type { Tool } from "./types.js";

export interface StatsArgs {
  project?: string;
}

export interface StatsResult {
  project: string;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  by_epic: Record<string, number>;
  by_type: Record<string, number>;
  by_effort: Record<string, number>;
  totals: {
    tickets: number;
    points: number;
  };
}

export function makeStatsTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<StatsArgs, StatsResult> {
  return {
    name: "tickets.stats",
    description:
      "Counts grouped by status, priority, epic, type, and effort for the active project. " +
      "Supports project: 'all' for cross-project aggregates.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
      },
      additionalProperties: false,
    },

    parseArgs(raw: unknown): StatsArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;
      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
      };
    },

    async handle(args: StatsArgs): Promise<StatsResult> {
      const project = await requireProject(db, { project: args.project, allowAll: true }, getClientRoots);
      const isAll = project.id === "all";

      const projectFilter = isAll ? "" : "WHERE project_id = ?";
      const projectParam = isAll ? [] : [project.id];

      function groupBy(column: string): Record<string, number> {
        const rows = db
          .prepare(
            `SELECT ${column} as val, COUNT(*) as cnt FROM tickets ${projectFilter} GROUP BY ${column}`,
          )
          .all(projectParam) as Array<{ val: string | null; cnt: number }>;
        const result: Record<string, number> = {};
        for (const row of rows) {
          result[row.val ?? "null"] = row.cnt;
        }
        return result;
      }

      const by_status = groupBy("status");
      const by_priority = groupBy("priority");
      const by_epic = groupBy("epic");
      const by_type = groupBy("type");
      const by_effort = groupBy("effort");

      // Totals.
      const totalsRow = db
        .prepare(
          `SELECT COUNT(*) as ticket_count, COALESCE(SUM(effort), 0) as point_sum FROM tickets ${projectFilter}`,
        )
        .get(projectParam) as { ticket_count: number; point_sum: number };

      return {
        project: project.id,
        by_status,
        by_priority,
        by_epic,
        by_type,
        by_effort,
        totals: {
          tickets: totalsRow.ticket_count,
          points: totalsRow.point_sum,
        },
      };
    },
  };
}
