import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { writeAudit } from "../lib/audit.js";
import { nowIso } from "../lib/now.js";
import type { Tool } from "./types.js";

export interface AppendToDescriptionArgs {
  project?: string;
  id: string;
  text: string;
  separator?: string;
  full?: boolean;
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

/** Lean default return: id plus the resulting concatenated description. */
export interface AppendToDescriptionResultLean {
  id: string;
  description: string;
}

/** Full opt-in return: the complete ticket row (back-compat shape). */
export interface AppendToDescriptionResultFull {
  ticket: TicketRow;
}

export type AppendToDescriptionResult =
  | AppendToDescriptionResultLean
  | AppendToDescriptionResultFull;

export function makeAppendToDescriptionTool(
  db: Database.Database,
  getClientRoots: GetClientRoots = NO_ROOTS,
): Tool<AppendToDescriptionArgs, AppendToDescriptionResult> {
  return {
    name: "tickets.append_to_description",
    description:
      "Append text to a ticket's description. " +
      "Uses a separator (default \\n\\n) unless the description is currently empty.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id. Omit to resolve from cwd." },
        id: { type: "string", description: "Ticket id." },
        text: { type: "string", description: "Text to append (must be non-empty)." },
        separator: {
          type: "string",
          description: "Separator inserted between old description and new text. Default: \\n\\n.",
        },
        full: { type: "boolean", description: "Return the full ticket row instead of the lean default." },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): AppendToDescriptionArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      const id = r["id"];
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "id must be a non-empty string.");
      }

      const text = r["text"];
      if (typeof text !== "string" || text.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "text must be non-empty.");
      }

      const separator = r["separator"];
      if (separator !== undefined && typeof separator !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "separator must be a string.");
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        id,
        text,
        separator: typeof separator === "string" ? separator : undefined,
        full: r["full"] === true,
      };
    },

    async handle(args: AppendToDescriptionArgs): Promise<AppendToDescriptionResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;
      const ticketId = args.id;

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

      const separator = args.separator ?? "\n\n";
      const currentDesc = current.description;
      const newDesc = currentDesc === "" ? args.text : currentDesc + separator + args.text;
      const changedAt = nowIso();

      const doUpdate = db.transaction(() => {
        db.prepare(
          "UPDATE tickets SET description = ? WHERE project_id = ? AND id = ?",
        ).run(newDesc, projectId, ticketId);

        writeAudit(db, {
          projectId,
          ticketId,
          field: "description:append",
          oldValue: null,
          newValue: args.text,
          changedAt,
        });
      });

      doUpdate();

      const updated = db
        .prepare("SELECT * FROM tickets WHERE project_id = ? AND id = ?")
        .get(projectId, ticketId) as TicketRow;

      if (args.full) {
        return { ticket: updated };
      }
      return { id: updated.id, description: updated.description };
    },
  };
}
