import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import type { Tool } from "./types.js";

export interface ProgressArgs {
  project?: string;
}

export interface ProgressTotals {
  tickets: number;
  done_tickets: number;
  points: number;
  done_points: number;
  pct: number;
  unsized: number;
  basis: "points" | "tickets";
}

export interface ProgressResult {
  project: string;
  totals: ProgressTotals;
  by_status: Record<string, number>;
}

/** Statuses counted toward every progress figure; `deferred` sits outside the population entirely. */
const POPULATION_SQL = "status IN ('open', 'in_progress', 'blocked', 'done')";

interface CountRow {
  tickets: number;
  done_tickets: number;
  points: number;
  done_points: number;
  unsized: number;
}

function countRow(db: Database.Database, whereSql: string, params: unknown[]): CountRow {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) as tickets,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done_tickets,
         SUM(COALESCE(effort, 0)) as points,
         SUM(CASE WHEN status = 'done' THEN COALESCE(effort, 0) ELSE 0 END) as done_points,
         SUM(CASE WHEN effort IS NULL THEN 1 ELSE 0 END) as unsized
       FROM tickets
       WHERE ${whereSql}`,
    )
    .get(params) as {
    tickets: number;
    done_tickets: number | null;
    points: number | null;
    done_points: number | null;
    unsized: number | null;
  };

  return {
    tickets: row.tickets,
    done_tickets: row.done_tickets ?? 0,
    points: row.points ?? 0,
    done_points: row.done_points ?? 0,
    unsized: row.unsized ?? 0,
  };
}

export function makeProgressTool(
  db: Database.Database,
  getClientRoots: GetClientRoots = NO_ROOTS,
): Tool<ProgressArgs, ProgressResult> {
  return {
    name: "tickets.progress",
    description:
      "Headline completion percentage for the active project; deferred tickets are excluded, percentage is points-based.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
      },
      additionalProperties: false,
    },

    parseArgs(raw: unknown): ProgressArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;
      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
      };
    },

    async handle(args: ProgressArgs): Promise<ProgressResult> {
      const project = await requireProject(db, { project: args.project, allowAll: true }, getClientRoots);
      const isAll = project.id === "all";

      const projectFilter = isAll ? "" : "AND project_id = ?";
      const projectParam = isAll ? [] : [project.id];
      const whereSql = `${POPULATION_SQL} ${projectFilter}`;

      const counts = countRow(db, whereSql, projectParam);

      const points = counts.points;
      const basis: "points" | "tickets" = points > 0 ? "points" : "tickets";
      const pct =
        points > 0
          ? Math.round((100 * counts.done_points) / points)
          : counts.tickets > 0
            ? Math.round((100 * counts.done_tickets) / counts.tickets)
            : 0;

      const statusRows = db
        .prepare(
          `SELECT status, COUNT(*) as cnt FROM tickets WHERE ${whereSql} GROUP BY status`,
        )
        .all(projectParam) as Array<{ status: string; cnt: number }>;
      const by_status: Record<string, number> = {};
      for (const row of statusRows) {
        by_status[row.status] = row.cnt;
      }

      return {
        project: project.id,
        totals: {
          tickets: counts.tickets,
          done_tickets: counts.done_tickets,
          points: counts.points,
          done_points: counts.done_points,
          pct,
          unsized: counts.unsized,
          basis,
        },
        by_status,
      };
    },
  };
}
