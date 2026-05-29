import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import type { Tool } from "./types.js";

export interface ValidateArgs {
  project?: string;
}

interface Issue {
  kind: string;
  severity: "error" | "info";
  ticket_id: string | null;
  detail: string;
}

export interface ValidateResult {
  project: string;
  ok: boolean;
  issues: Issue[];
}

export function makeValidateTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<ValidateArgs, ValidateResult> {
  return {
    name: "tickets.validate",
    description:
      "Run integrity checks on a project's tickets and relations. " +
      "Checks: orphan parent_id (error), dangling relations (error), " +
      "closed_at set with non-terminal status (error), " +
      "terminal status with null closed_at (info — legal post-import). " +
      "Returns { project, ok, issues }. ok=true when no error-severity issues exist.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
      },
      additionalProperties: false,
    },

    parseArgs(raw: unknown): ValidateArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;
      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
      };
    },

    async handle(args: ValidateArgs): Promise<ValidateResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;

      const issues: Issue[] = [];

      // Check 1: orphan parent_id — tickets whose parent_id points at a non-existent ticket.
      const orphans = db
        .prepare(
          `SELECT id, parent_id FROM tickets
           WHERE project_id = ? AND parent_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM tickets p
               WHERE p.project_id = tickets.project_id AND p.id = tickets.parent_id
             )`,
        )
        .all(projectId) as Array<{ id: string; parent_id: string }>;

      for (const row of orphans) {
        issues.push({
          kind: "orphan_parent",
          severity: "error",
          ticket_id: row.id,
          detail: `Ticket ${row.id} has parent_id '${row.parent_id}' which does not exist.`,
        });
      }

      // Check 2: dangling relations — from_id or to_id doesn't exist.
      const danglingFrom = db
        .prepare(
          `SELECT r.from_id, r.to_id, r.kind FROM relations r
           WHERE r.project_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM tickets t WHERE t.project_id = r.project_id AND t.id = r.from_id
             )`,
        )
        .all(projectId) as Array<{ from_id: string; to_id: string; kind: string }>;

      for (const row of danglingFrom) {
        issues.push({
          kind: "dangling_relation",
          severity: "error",
          ticket_id: null,
          detail: `Relation ${row.from_id}->${row.to_id} (${row.kind}): from_id '${row.from_id}' does not exist.`,
        });
      }

      const danglingTo = db
        .prepare(
          `SELECT r.from_id, r.to_id, r.kind FROM relations r
           WHERE r.project_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM tickets t WHERE t.project_id = r.project_id AND t.id = r.to_id
             )`,
        )
        .all(projectId) as Array<{ from_id: string; to_id: string; kind: string }>;

      for (const row of danglingTo) {
        issues.push({
          kind: "dangling_relation",
          severity: "error",
          ticket_id: null,
          detail: `Relation ${row.from_id}->${row.to_id} (${row.kind}): to_id '${row.to_id}' does not exist.`,
        });
      }

      // Check 3: closed_at set but status is not terminal.
      const closedNotTerminal = db
        .prepare(
          `SELECT id, status, closed_at FROM tickets
           WHERE project_id = ? AND closed_at IS NOT NULL
             AND status NOT IN ('done','deferred')`,
        )
        .all(projectId) as Array<{ id: string; status: string; closed_at: string }>;

      for (const row of closedNotTerminal) {
        issues.push({
          kind: "closed_without_terminal_status",
          severity: "error",
          ticket_id: row.id,
          detail: `Ticket ${row.id} has closed_at set but status is '${row.status}' (not done/deferred).`,
        });
      }

      // Check 4: terminal status but no closed_at — info only (legal post-import per spec §7).
      const terminalNoClosed = db
        .prepare(
          `SELECT id, status FROM tickets
           WHERE project_id = ? AND status IN ('done','deferred') AND closed_at IS NULL`,
        )
        .all(projectId) as Array<{ id: string; status: string }>;

      for (const row of terminalNoClosed) {
        issues.push({
          kind: "terminal_without_closed_at",
          severity: "info",
          ticket_id: row.id,
          detail: `Ticket ${row.id} has status '${row.status}' but closed_at is null (legal post-import).`,
        });
      }

      const ok = !issues.some((i) => i.severity === "error");

      return { project: projectId, ok, issues };
    },
  };
}
