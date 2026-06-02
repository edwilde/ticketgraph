import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { writeAudit } from "../lib/audit.js";
import { nowIso } from "../lib/now.js";
import { wouldCreateCycle } from "../lib/cycles.js";
import type { Tool } from "./types.js";

const VALID_STATUSES = new Set(["open", "in_progress", "blocked", "done", "deferred"]);
const VALID_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const VALID_TYPES = new Set(["task", "bug", "spike", "followup", "umbrella"]);
const VALID_EFFORTS = new Set([1, 2, 3, 5, 8, 13]);

const PATCHABLE_FIELDS = new Set([
  "title",
  "description",
  "status",
  "priority",
  "type",
  "effort",
  "epic",
  "parent_id",
  "created_by",
]);

const FORBIDDEN_FIELDS = new Set(["id", "project_id", "created_at", "closed_at"]);

export interface UpdatePatch {
  title?: string;
  description?: string;
  status?: string;
  priority?: string | null;
  type?: string;
  effort?: number | null;
  epic?: string | null;
  parent_id?: string | null;
  created_by?: string;
}

export interface UpdateArgs {
  project?: string;
  id: string;
  patch: UpdatePatch;
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

/** Lean default return. */
export interface UpdateResultLean {
  id: string;
  changed: string[];
  /** Present only when a status change fired the closed_at trigger. */
  closed_at?: string | null;
  audit_entries: number;
}

/** Full opt-in return: the complete ticket row (back-compat shape). */
export interface UpdateResultFull {
  ticket: TicketRow;
  audit_entries: number;
}

export type UpdateResult = UpdateResultLean | UpdateResultFull;

export function makeUpdateTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<UpdateArgs, UpdateResult> {
  return {
    name: "tickets.update",
    description:
      "Patch any subset of a ticket's mutable fields. Each changed field writes one audit row. " +
      "No-op patches (all values unchanged) return immediately without writing anything.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id. Omit to resolve from cwd." },
        id: { type: "string", description: "Ticket id to update." },
        patch: {
          type: "object",
          description: "Fields to update. At least one key required.",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["open", "in_progress", "blocked", "done", "deferred"] },
            priority: { type: "string", enum: ["P0", "P1", "P2", "P3"], nullable: true },
            type: { type: "string", enum: ["task", "bug", "spike", "followup", "umbrella"] },
            effort: { type: "number", enum: [1, 2, 3, 5, 8, 13], nullable: true },
            epic: { type: "string", nullable: true },
            parent_id: { type: "string", nullable: true },
            created_by: { type: "string" },
          },
          additionalProperties: false,
        },
        full: { type: "boolean", description: "Return the full ticket row instead of the lean default." },
      },
      required: ["id", "patch"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): UpdateArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      const id = r["id"];
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "id must be a non-empty string.");
      }

      const patchRaw = r["patch"];
      if (typeof patchRaw !== "object" || patchRaw === null || Array.isArray(patchRaw)) {
        throw new McpError(ErrorCode.InvalidParams, "patch must be an object.");
      }
      const p = patchRaw as Record<string, unknown>;

      const patchKeys = Object.keys(p);
      if (patchKeys.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "patch must contain at least one field.");
      }

      // Reject forbidden and unknown keys.
      for (const key of patchKeys) {
        if (FORBIDDEN_FIELDS.has(key)) {
          throw new McpError(ErrorCode.InvalidParams, `Field '${key}' is not patchable.`);
        }
        if (!PATCHABLE_FIELDS.has(key)) {
          throw new McpError(ErrorCode.InvalidParams, `Field '${key}' is not patchable.`);
        }
      }

      // Validate field types.
      const patch: UpdatePatch = {};

      if ("title" in p) {
        if (typeof p["title"] !== "string" || (p["title"] as string).trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "title must be a non-empty string.");
        }
        patch.title = p["title"] as string;
      }

      if ("description" in p) {
        if (typeof p["description"] !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "description must be a string.");
        }
        patch.description = p["description"] as string;
      }

      if ("status" in p) {
        const status = p["status"] as string;
        if (!VALID_STATUSES.has(status)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `status must be one of: ${[...VALID_STATUSES].join(", ")}`,
          );
        }
        patch.status = status;
      }

      if ("priority" in p) {
        const priority = p["priority"] as string | null;
        if (priority != null && !VALID_PRIORITIES.has(priority)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `priority must be one of: ${[...VALID_PRIORITIES].join(", ")}`,
          );
        }
        patch.priority = priority;
      }

      if ("type" in p) {
        const type = p["type"] as string;
        if (!VALID_TYPES.has(type)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `type must be one of: ${[...VALID_TYPES].join(", ")}`,
          );
        }
        patch.type = type;
      }

      if ("effort" in p) {
        const effort = p["effort"] as number | null;
        if (effort != null && !VALID_EFFORTS.has(effort)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `effort must be one of: ${[...VALID_EFFORTS].join(", ")} or null`,
          );
        }
        patch.effort = effort;
      }

      if ("epic" in p) {
        patch.epic = (p["epic"] as string | null | undefined) ?? null;
      }

      if ("parent_id" in p) {
        patch.parent_id = (p["parent_id"] as string | null | undefined) ?? null;
      }

      if ("created_by" in p) {
        if (typeof p["created_by"] !== "string") {
          throw new McpError(ErrorCode.InvalidParams, "created_by must be a string.");
        }
        patch.created_by = p["created_by"] as string;
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        id,
        patch,
        full: r["full"] === true,
      };
    },

    async handle(args: UpdateArgs): Promise<UpdateResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;
      const ticketId = args.id;

      // SELECT current row.
      const current = db
        .prepare("SELECT * FROM tickets WHERE project_id = ? AND id = ?")
        .get(projectId, ticketId) as TicketRow | undefined;

      if (!current) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Ticket '${projectId}/${ticketId}' not found.`,
        );
      }

      // Compute diff.
      const patch = args.patch;
      const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];

      function toAuditStr(val: unknown): string | null {
        if (val === null || val === undefined) return null;
        return String(val);
      }

      const fieldChecks: Array<keyof UpdatePatch> = [
        "title", "description", "status", "priority", "type",
        "effort", "epic", "parent_id", "created_by",
      ];

      for (const field of fieldChecks) {
        if (!(field in patch)) continue;
        const newVal = patch[field] as unknown;
        const oldVal = current[field as keyof TicketRow] as unknown;
        // Compare as strings for consistency (handles null vs undefined).
        const newStr = toAuditStr(newVal);
        const oldStr = toAuditStr(oldVal);
        if (newStr !== oldStr) {
          changes.push({ field, oldValue: oldStr, newValue: newStr });
        }
      }

      // No-op: return early without touching the DB.
      if (changes.length === 0) {
        if (args.full) {
          return { ticket: current, audit_entries: 0 };
        }
        return { id: ticketId, changed: [], audit_entries: 0 };
      }

      // Cycle detection for parent_id changes.
      if ("parent_id" in patch && patch.parent_id != null) {
        let hasCycle: boolean;
        try {
          hasCycle = wouldCreateCycle(db, {
            projectId,
            ticketId,
            newParentId: patch.parent_id,
          });
        } catch (err) {
          throw new McpError(ErrorCode.InvalidParams, String(err));
        }
        if (hasCycle) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Setting parent_id to '${patch.parent_id}' would create a cycle.`,
          );
        }
      }

      // Build the UPDATE statement dynamically from patch keys.
      const setClauses: string[] = [];
      const setValues: unknown[] = [];

      for (const field of fieldChecks) {
        if (!(field in patch)) continue;
        setClauses.push(`${field} = ?`);
        const val = patch[field];
        setValues.push(val === undefined ? null : val);
      }

      const changedAt = nowIso();

      const doUpdate = db.transaction(() => {
        try {
          db.prepare(
            `UPDATE tickets SET ${setClauses.join(", ")} WHERE project_id = ? AND id = ?`,
          ).run(...setValues, projectId, ticketId);
        } catch (err) {
          const msg = String(err);
          if (msg.includes("SQLITE_CONSTRAINT_CHECK") || msg.includes("CHECK constraint failed")) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `effort must be one of 1, 2, 3, 5, 8, 13 or NULL`,
            );
          }
          if (
            msg.includes("SQLITE_CONSTRAINT_FOREIGNKEY") ||
            msg.includes("FOREIGN KEY constraint failed")
          ) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `parent_id '${patch.parent_id}' not found in project '${projectId}'.`,
            );
          }
          throw new McpError(ErrorCode.InvalidParams, `Update failed: ${msg}`);
        }

        for (const { field, oldValue, newValue } of changes) {
          writeAudit(db, { projectId, ticketId, field, oldValue, newValue, changedAt });
        }
      });

      doUpdate();

      // Re-SELECT to pick up trigger-managed fields (e.g. closed_at).
      const updated = db
        .prepare("SELECT * FROM tickets WHERE project_id = ? AND id = ?")
        .get(projectId, ticketId) as TicketRow;

      if (args.full) {
        return { ticket: updated, audit_entries: changes.length };
      }

      const changed = changes.map((c) => c.field);
      const result: UpdateResultLean = {
        id: ticketId,
        changed,
        audit_entries: changes.length,
      };
      // closed_at is trigger-managed: surface it only when status changed,
      // since that is the transition that can set or clear it.
      if (changed.includes("status")) {
        result.closed_at = updated.closed_at;
      }
      return result;
    },
  };
}
