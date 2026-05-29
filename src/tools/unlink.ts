import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { writeAudit } from "../lib/audit.js";
import { nowIso } from "../lib/now.js";
import type { Tool } from "./types.js";

export interface UnlinkArgs {
  project?: string;
  from: string;
  to: string;
  kind: string;
}

export interface UnlinkResult {
  removed: true;
}

export function makeUnlinkTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<UnlinkArgs, UnlinkResult> {
  return {
    name: "tickets.unlink",
    description: "Remove a directed typed relation between two tickets.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id. Omit to resolve from cwd." },
        from: { type: "string", description: "Source ticket id." },
        to: { type: "string", description: "Target ticket id." },
        kind: { type: "string", description: "Relation kind to remove." },
      },
      required: ["from", "to", "kind"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): UnlinkArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      const from = r["from"];
      if (typeof from !== "string" || from.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "from must be a non-empty string.");
      }

      const to = r["to"];
      if (typeof to !== "string" || to.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "to must be a non-empty string.");
      }

      const kind = r["kind"];
      if (typeof kind !== "string" || kind.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "kind must be a non-empty string.");
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        from,
        to,
        kind,
      };
    },

    async handle(args: UnlinkArgs): Promise<UnlinkResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;

      const changedAt = nowIso();

      const doDelete = db.transaction(() => {
        const result = db
          .prepare(
            "DELETE FROM relations WHERE project_id = ? AND from_id = ? AND to_id = ? AND kind = ?",
          )
          .run(projectId, args.from, args.to, args.kind);

        if (result.changes === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No ${args.kind} relation ${args.from}->${args.to} to remove.`,
          );
        }

        writeAudit(db, {
          projectId,
          ticketId: args.from,
          field: `relation:${args.kind}`,
          oldValue: `${args.from}->${args.to}`,
          newValue: null,
          changedAt,
        });
      });

      doDelete();

      return { removed: true };
    },
  };
}
