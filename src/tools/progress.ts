import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import type { Tool } from "./types.js";

/** Allowed `by` values, shared between `parseArgs` validation and the `inputSchema` enum. */
const BY_VALUES = ["epic", "parent", "type", "tag"] as const;
export type ByValue = (typeof BY_VALUES)[number];

export interface ProgressArgs {
  project?: string;
  by?: ByValue;
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

export interface ProgressGroup {
  key: string;
  tickets: number;
  done_tickets: number;
  points: number;
  done_points: number;
  pct: number;
  unsized: number;
}

export interface ProgressResult {
  project: string;
  totals: ProgressTotals;
  by_status: Record<string, number>;
  groups?: ProgressGroup[];
}

/** Statuses counted toward every progress figure; `deferred` sits outside the population entirely. */
const POPULATION_SQL = "tickets.status IN ('open', 'in_progress', 'blocked', 'done')";

/**
 * Group column per `by` value. `epic`/`parent` fall back to `(none)` for a
 * NULL column; `type` is NOT NULL so never produces a `(none)` row; `tag`
 * needs the tags table, joined only when grouping by tag so the headline
 * (ungrouped) query never double-counts a multi-tagged ticket.
 */
const BY_CONFIG: Record<ByValue, { expr: string; join?: string }> = {
  epic: { expr: "COALESCE(tickets.epic, '(none)')" },
  parent: { expr: "COALESCE(tickets.parent_id, '(none)')" },
  type: { expr: "tickets.type" },
  tag: {
    expr: "COALESCE(tags.tag, '(none)')",
    join: "LEFT JOIN tags ON tags.project_id = tickets.project_id AND tags.ticket_id = tickets.id",
  },
};

interface CountRow {
  tickets: number;
  done_tickets: number;
  points: number;
  done_points: number;
  unsized: number;
}

interface KeyedCountRow extends CountRow {
  key: string;
}

/**
 * Runs the shared conditional-aggregate SELECT, optionally joined and
 * grouped. With no `groupByExpr` this always returns exactly one row (a
 * bare aggregate query with no GROUP BY still yields one row, even when
 * COUNT(*) is 0), so `countRow` below can safely take the first element.
 */
function countRows(
  db: Database.Database,
  whereSql: string,
  params: unknown[],
  opts: { join?: string; groupByExpr?: string } = {},
): KeyedCountRow[] {
  const join = opts.join ?? "";
  const keyExpr = opts.groupByExpr ?? "''";
  const groupClause = opts.groupByExpr ? `GROUP BY ${opts.groupByExpr}` : "";

  const rows = db
    .prepare(
      `SELECT
         ${keyExpr} as key,
         COUNT(*) as tickets,
         SUM(CASE WHEN tickets.status = 'done' THEN 1 ELSE 0 END) as done_tickets,
         SUM(COALESCE(tickets.effort, 0)) as points,
         SUM(CASE WHEN tickets.status = 'done' THEN COALESCE(tickets.effort, 0) ELSE 0 END) as done_points,
         SUM(CASE WHEN tickets.effort IS NULL THEN 1 ELSE 0 END) as unsized
       FROM tickets
       ${join}
       WHERE ${whereSql}
       ${groupClause}`,
    )
    .all(params) as Array<{
    key: string;
    tickets: number;
    done_tickets: number | null;
    points: number | null;
    done_points: number | null;
    unsized: number | null;
  }>;

  return rows.map((row) => ({
    key: row.key,
    tickets: row.tickets,
    done_tickets: row.done_tickets ?? 0,
    points: row.points ?? 0,
    done_points: row.done_points ?? 0,
    unsized: row.unsized ?? 0,
  }));
}

function countRow(db: Database.Database, whereSql: string, params: unknown[]): CountRow {
  const [row] = countRows(db, whereSql, params);
  return row ?? { tickets: 0, done_tickets: 0, points: 0, done_points: 0, unsized: 0 };
}

/** Percentage-done with the points-if-any-else-tickets fallback, shared by `totals` and every group. */
function computePct(points: number, donePoints: number, tickets: number, doneTickets: number): number {
  return points > 0
    ? Math.round((100 * donePoints) / points)
    : tickets > 0
      ? Math.round((100 * doneTickets) / tickets)
      : 0;
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
        by: {
          type: "string",
          enum: [...BY_VALUES],
          description:
            "Group headline counts by epic, parent ticket, type, or tag. Tag grouping counts a ticket once per tag, so group totals can exceed the project total.",
        },
      },
      additionalProperties: false,
    },

    parseArgs(raw: unknown): ProgressArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      const byRaw = r["by"];
      let by: ByValue | undefined;
      if (byRaw !== undefined) {
        if (typeof byRaw !== "string" || !(BY_VALUES as readonly string[]).includes(byRaw)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `by must be one of: ${BY_VALUES.join(", ")} (got '${String(byRaw)}')`,
          );
        }
        by = byRaw as ByValue;
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        by,
      };
    },

    async handle(args: ProgressArgs): Promise<ProgressResult> {
      const project = await requireProject(db, { project: args.project, allowAll: true }, getClientRoots);
      const isAll = project.id === "all";

      const projectFilter = isAll ? "" : "AND tickets.project_id = ?";
      const projectParam = isAll ? [] : [project.id];
      const whereSql = `${POPULATION_SQL} ${projectFilter}`;

      const counts = countRow(db, whereSql, projectParam);

      const points = counts.points;
      const basis: "points" | "tickets" = points > 0 ? "points" : "tickets";
      const pct = computePct(counts.points, counts.done_points, counts.tickets, counts.done_tickets);

      const statusRows = db
        .prepare(
          `SELECT tickets.status as status, COUNT(*) as cnt FROM tickets WHERE ${whereSql} GROUP BY tickets.status`,
        )
        .all(projectParam) as Array<{ status: string; cnt: number }>;
      const by_status: Record<string, number> = {};
      for (const row of statusRows) {
        by_status[row.status] = row.cnt;
      }

      const result: ProgressResult = {
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

      if (args.by !== undefined) {
        const config = BY_CONFIG[args.by];
        const groupRows = countRows(db, whereSql, projectParam, {
          join: config.join,
          groupByExpr: config.expr,
        });

        result.groups = groupRows
          .map((row) => ({
            key: row.key,
            tickets: row.tickets,
            done_tickets: row.done_tickets,
            points: row.points,
            done_points: row.done_points,
            pct: computePct(row.points, row.done_points, row.tickets, row.done_tickets),
            unsized: row.unsized,
          }))
          .sort((a, b) => a.pct - b.pct || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      }

      return result;
    },
  };
}
