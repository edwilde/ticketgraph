import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { writeAudit } from "../lib/audit.js";
import { nowIso } from "../lib/now.js";
import { normaliseTag } from "../lib/tags.js";
import { ticketExists } from "../lib/relations.js";
import type { Tool } from "./types.js";

export interface RemoveTagArgs {
  project?: string;
  id: string;
  tag: string;
}

export interface RemoveTagResult {
  tags: string[];
}

export function makeRemoveTagTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<RemoveTagArgs, RemoveTagResult> {
  return {
    name: "tickets.remove_tag",
    description:
      "Remove a tag from a ticket. The tag is normalised before matching. " +
      "Removing an absent tag is a no-op (idempotent, no error).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id. Omit to resolve from cwd." },
        id: { type: "string", description: "Ticket id." },
        tag: { type: "string", description: "Tag to remove." },
      },
      required: ["id", "tag"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): RemoveTagArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      const id = r["id"];
      if (typeof id !== "string" || id.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "id must be a non-empty string.");
      }

      const tag = r["tag"];
      if (typeof tag !== "string") {
        throw new McpError(ErrorCode.InvalidParams, "tag must be a string.");
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        id,
        tag,
      };
    },

    async handle(args: RemoveTagArgs): Promise<RemoveTagResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;
      const ticketId = args.id;

      if (!ticketExists(db, projectId, ticketId)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Ticket ${projectId}/${ticketId} not found.`,
        );
      }

      const normTag = normaliseTag(args.tag);

      const changedAt = nowIso();

      const doDelete = db.transaction(() => {
        const result = db
          .prepare(
            "DELETE FROM tags WHERE project_id = ? AND ticket_id = ? AND tag = ?",
          )
          .run(projectId, ticketId, normTag);

        // Only write audit if a row was actually deleted.
        if (result.changes === 1) {
          writeAudit(db, {
            projectId,
            ticketId,
            field: "tag",
            oldValue: normTag,
            newValue: null,
            changedAt,
          });
        }
      });

      doDelete();

      const tagRows = db
        .prepare(
          "SELECT tag FROM tags WHERE project_id = ? AND ticket_id = ? ORDER BY tag",
        )
        .all(projectId, ticketId) as Array<{ tag: string }>;

      return { tags: tagRows.map((r) => r.tag) };
    },
  };
}
