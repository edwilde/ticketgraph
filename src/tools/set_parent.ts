import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { writeAudit } from "../lib/audit.js";
import { nowIso } from "../lib/now.js";
import { wouldCreateCycle } from "../lib/cycles.js";
import { ticketExists } from "../lib/relations.js";
import type { Tool } from "./types.js";

export interface SetParentArgs {
  project?: string;
  id: string;
  parent_id: string | null;
}

interface TicketRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: string;
  priority: string | null;
  type: string;
  effort: number | null;
  epic: string | null;
  parent_id: string | null;
  created_by: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface SetParentResult {
  ticket: TicketRow;
  changed: boolean;
}

export function makeSetParentTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<SetParentArgs, SetParentResult> {
  return {
    name: "tickets.set_parent",
    description:
      "Set or clear a ticket's parent. Validates that the change would not create a cycle. " +
      "Pass parent_id: null to detach from any parent.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id. Omit to resolve from cwd." },
        id: { type: "string", description: "Ticket id to reparent." },
        parent_id: {
          type: "string",
          nullable: true,
          description: "New parent ticket id, or null to clear.",
        },
      },
      required: ["id", "parent_id"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): SetParentArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      const id = r["id"];
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "id must be a non-empty string.");
      }

      if (!("parent_id" in r)) {
        throw new McpError(ErrorCode.InvalidParams, "parent_id is required (use null to clear).");
      }
      const rawParentId = r["parent_id"];
      if (rawParentId !== null && typeof rawParentId !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "parent_id must be a string or null.");
      }
      if (typeof rawParentId === "string" && rawParentId.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "parent_id must be a non-empty string or null.");
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        id,
        parent_id: rawParentId as string | null,
      };
    },

    async handle(args: SetParentArgs): Promise<SetParentResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;
      const ticketId = args.id;
      const newParentId = args.parent_id;

      // Fetch current row.
      const current = db
        .prepare("SELECT * FROM tickets WHERE project_id = ? AND id = ?")
        .get(projectId, ticketId) as TicketRow | undefined;

      if (!current) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Ticket '${projectId}/${ticketId}' not found.`,
        );
      }

      // Reject self-parent.
      if (newParentId !== null && newParentId === ticketId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `A ticket cannot be its own parent.`,
        );
      }

      // No-op: same parent as current.
      if (newParentId === current.parent_id) {
        return { ticket: current, changed: false };
      }

      if (newParentId !== null) {
        // Validate parent exists.
        if (!ticketExists(db, projectId, newParentId)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `parent_id '${newParentId}' does not exist in project '${projectId}'.`,
          );
        }

        // Cycle detection.
        let hasCycle: boolean;
        try {
          hasCycle = wouldCreateCycle(db, { projectId, ticketId, newParentId });
        } catch (err) {
          throw new McpError(ErrorCode.InvalidParams, String(err));
        }
        if (hasCycle) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Setting parent_id to '${newParentId}' would create a cycle.`,
          );
        }
      }

      const changedAt = nowIso();
      const oldValue = current.parent_id;
      const newValue = newParentId;

      const doUpdate = db.transaction(() => {
        db.prepare(
          "UPDATE tickets SET parent_id = ? WHERE project_id = ? AND id = ?",
        ).run(newValue, projectId, ticketId);

        writeAudit(db, {
          projectId,
          ticketId,
          field: "parent_id",
          oldValue,
          newValue,
          changedAt,
        });
      });

      doUpdate();

      const updated = db
        .prepare("SELECT * FROM tickets WHERE project_id = ? AND id = ?")
        .get(projectId, ticketId) as TicketRow;

      return { ticket: updated, changed: true };
    },
  };
}
