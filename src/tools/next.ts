import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import type { Tool } from "./types.js";

export interface NextArgs {
  project?: string;
  type?: string;
}

interface TicketRow {
  id: string;
  project_id: string;
  title: string;
  status: string;
  priority: string | null;
  type: string;
  effort: number | null;
  created_at: string;
  closed_at: string | null;
  parent_id: string | null;
}

export interface NextResult {
  ticket: TicketRow | null;
  reason: {
    priority: string | null;
    age_days: number;
    no_open_blockers: true;
  } | null;
  message?: string;
}

export function makeNextTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<NextArgs, NextResult> {
  return {
    name: "tickets.next",
    description:
      "Return the highest-priority open ticket that has no open blockers. " +
      "A blocker whose status is done or deferred does not count. " +
      "Sort order: priority ASC NULLS LAST, created_at ASC, id ASC. " +
      "Returns { ticket, reason } on a hit, or { ticket: null, reason: null, message } when nothing qualifies — " +
      "the message explains the board state (counts of non-done tickets, or that the board is clear).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        type: { type: "string" },
      },
      additionalProperties: false,
    },

    parseArgs(raw: unknown): NextArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;
      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        type: typeof r["type"] === "string" ? r["type"] : undefined,
      };
    },

    async handle(args: NextArgs): Promise<NextResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;

      let sql =
        `SELECT t.id, t.project_id, t.title, t.status, t.priority, t.type, ` +
        `t.effort, t.created_at, t.closed_at, t.parent_id ` +
        `FROM tickets t ` +
        `WHERE t.project_id = ? AND t.status = 'open' ` +
        `AND NOT EXISTS ( ` +
        `  SELECT 1 FROM relations r ` +
        `  JOIN tickets b ON b.project_id = r.project_id AND b.id = r.from_id ` +
        `  WHERE r.project_id = t.project_id AND r.to_id = t.id AND r.kind = 'blocks' ` +
        `  AND b.status NOT IN ('done','deferred') ` +
        `) `;

      const params: unknown[] = [projectId];

      if (args.type !== undefined) {
        sql += `AND t.type = ? `;
        params.push(args.type);
      }

      sql += `ORDER BY (t.priority IS NULL), t.priority ASC, t.created_at ASC, t.id ASC LIMIT 1`;

      const row = db.prepare(sql).get(params) as TicketRow | undefined;

      if (!row) {
        const counts = db
          .prepare(
            `SELECT status, COUNT(*) AS n FROM tickets WHERE project_id = ? AND status != 'done' GROUP BY status ORDER BY status`,
          )
          .all(projectId) as { status: string; n: number }[];

        const message =
          counts.length === 0
            ? "nothing ready to work on — board is clear"
            : `nothing ready to work on; ${counts
                .map((c) => `${c.n} ${c.status}`)
                .join(", ")} non-done — run \`ticketgraph list --status outstanding\``;

        return { ticket: null, reason: null, message };
      }

      const now = Date.now();
      const created = new Date(row.created_at).getTime();
      const age_days = Math.floor((now - created) / 86400000);

      return {
        ticket: row,
        reason: {
          priority: row.priority,
          age_days,
          no_open_blockers: true,
        },
      };
    },
  };
}
