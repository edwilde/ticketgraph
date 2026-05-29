import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { inferNextId } from "../lib/numbering.js";
import { writeAudit } from "../lib/audit.js";
import { nowIso } from "../lib/now.js";
import type { Tool } from "./types.js";

const VALID_STATUSES = new Set(["open", "in_progress", "blocked", "done", "deferred"]);
const VALID_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const VALID_TYPES = new Set(["task", "bug", "spike", "followup", "umbrella"]);

export interface AddArgs {
  project?: string;
  id?: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string | null;
  type?: string;
  epic?: string | null;
  parent_id?: string | null;
  effort?: number | null;
  created_by?: string;
  tags?: string[];
}

export interface AddResult {
  ticket: TicketRow;
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

export function makeAddTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<AddArgs, AddResult> {
  return {
    name: "tickets.add",
    description:
      "Create a new ticket. If id is omitted, the server infers the next id from the project's existing ticket ids.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id. Omit to resolve from cwd." },
        id: { type: "string", description: "Ticket id. Omit to auto-generate." },
        title: { type: "string", description: "Ticket title (required)." },
        description: { type: "string" },
        status: { type: "string", enum: ["open", "in_progress", "blocked", "done", "deferred"] },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"], nullable: true },
        type: { type: "string", enum: ["task", "bug", "spike", "followup", "umbrella"] },
        epic: { type: "string", nullable: true },
        parent_id: { type: "string", nullable: true },
        effort: { type: "number", enum: [1, 2, 3, 5, 8, 13], nullable: true },
        created_by: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): AddArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      const title = r["title"];
      if (typeof title !== "string" || title.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "title must be a non-empty string.");
      }

      const status = r["status"] as string | undefined;
      if (status !== undefined && !VALID_STATUSES.has(status)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `status must be one of: ${[...VALID_STATUSES].join(", ")}`,
        );
      }

      const priority = r["priority"] as string | null | undefined;
      if (priority != null && !VALID_PRIORITIES.has(priority)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `priority must be one of: ${[...VALID_PRIORITIES].join(", ")}`,
        );
      }

      const type = r["type"] as string | undefined;
      if (type !== undefined && !VALID_TYPES.has(type)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `type must be one of: ${[...VALID_TYPES].join(", ")}`,
        );
      }

      const tags = r["tags"];
      if (tags !== undefined && !Array.isArray(tags)) {
        throw new McpError(ErrorCode.InvalidParams, "tags must be an array of strings.");
      }
      if (Array.isArray(tags) && tags.some((t) => typeof t !== "string")) {
        throw new McpError(ErrorCode.InvalidParams, "All tags must be strings.");
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        id: typeof r["id"] === "string" ? r["id"] : undefined,
        title,
        description: typeof r["description"] === "string" ? r["description"] : undefined,
        status,
        priority: (priority as string | null | undefined) ?? undefined,
        type,
        epic: (r["epic"] as string | null | undefined) ?? undefined,
        parent_id: (r["parent_id"] as string | null | undefined) ?? undefined,
        effort: (r["effort"] as number | null | undefined) ?? undefined,
        created_by: typeof r["created_by"] === "string" ? r["created_by"] : undefined,
        tags: Array.isArray(tags) ? (tags as string[]) : undefined,
      };
    },

    async handle(args: AddArgs): Promise<AddResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;

      // Determine ticket id.
      let ticketId: string;
      if (args.id !== undefined) {
        // Validate uniqueness.
        const existing = db
          .prepare("SELECT id FROM tickets WHERE project_id = ? AND id = ?")
          .get(projectId, args.id);
        if (existing) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Ticket '${projectId}/${args.id}' already exists.`,
          );
        }
        ticketId = args.id;
      } else {
        try {
          ticketId = inferNextId(db, projectId);
        } catch (err) {
          throw new McpError(ErrorCode.InvalidParams, String(err));
        }
      }

      // Validate parent_id exists in same project if supplied.
      if (args.parent_id != null) {
        const parent = db
          .prepare("SELECT id FROM tickets WHERE project_id = ? AND id = ?")
          .get(projectId, args.parent_id);
        if (!parent) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `parent_id '${args.parent_id}' does not exist in project '${projectId}'.`,
          );
        }
      }

      const created_at = nowIso();
      const description = args.description ?? "";
      const status = args.status ?? "open";
      const type = args.type ?? "task";
      const created_by = args.created_by ?? "claude";

      // Normalise and dedup tags.
      const rawTags = args.tags ?? [];
      const tags = [...new Set(rawTags.map((t) => t.trim().toLowerCase()))].filter((t) => t.length > 0);

      const insertTicket = db.prepare(
        `INSERT INTO tickets (id, project_id, title, description, status, priority, type, effort, epic, parent_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const insertTag = db.prepare(
        "INSERT INTO tags (project_id, ticket_id, tag) VALUES (?, ?, ?)",
      );

      const doInsert = db.transaction(() => {
        try {
          insertTicket.run(
            ticketId,
            projectId,
            args.title,
            description,
            status,
            args.priority ?? null,
            type,
            args.effort ?? null,
            args.epic ?? null,
            args.parent_id ?? null,
            created_by,
            created_at,
          );
        } catch (err) {
          const msg = String(err);
          if (msg.includes("SQLITE_CONSTRAINT_CHECK") || msg.includes("CHECK constraint failed")) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Invalid field value: ${msg}`,
            );
          }
          if (msg.includes("SQLITE_CONSTRAINT_FOREIGNKEY") || msg.includes("FOREIGN KEY constraint failed")) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Foreign key constraint failed — check parent_id exists in the same project.`,
            );
          }
          throw new McpError(ErrorCode.InvalidParams, `Insert failed: ${msg}`);
        }

        for (const tag of tags) {
          insertTag.run(projectId, ticketId, tag);
        }

        writeAudit(db, {
          projectId,
          ticketId,
          field: "_created",
          oldValue: null,
          newValue: ticketId,
          changedAt: created_at,
        });
      });

      doInsert();

      // Re-select the full row.
      const row = db
        .prepare("SELECT * FROM tickets WHERE project_id = ? AND id = ?")
        .get(projectId, ticketId) as TicketRow;

      return { ticket: row };
    },
  };
}
