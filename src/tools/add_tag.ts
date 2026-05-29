import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { writeAudit } from "../lib/audit.js";
import { nowIso } from "../lib/now.js";
import { normaliseTag } from "../lib/tags.js";
import { ticketExists } from "../lib/relations.js";
import type { Tool } from "./types.js";

export interface AddTagArgs {
  project?: string;
  id: string;
  tag: string;
}

export interface AddTagResult {
  tags: string[];
}

export function makeAddTagTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<AddTagArgs, AddTagResult> {
  return {
    name: "tickets.add_tag",
    description:
      "Add a tag to a ticket. The tag is normalised (trimmed, lowercased). " +
      "Adding an already-present tag is a no-op (idempotent).",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id. Omit to resolve from cwd." },
        id: { type: "string", description: "Ticket id." },
        tag: { type: "string", description: "Tag to add." },
      },
      required: ["id", "tag"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): AddTagArgs {
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

    async handle(args: AddTagArgs): Promise<AddTagResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;
      const ticketId = args.id;

      // Validate ticket exists.
      if (!ticketExists(db, projectId, ticketId)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Ticket '${projectId}/${ticketId}' not found.`,
        );
      }

      const normTag = normaliseTag(args.tag);
      if (normTag.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "tag must be non-empty after normalisation.");
      }

      const changedAt = nowIso();

      const doInsert = db.transaction(() => {
        const result = db
          .prepare("INSERT OR IGNORE INTO tags (project_id, ticket_id, tag) VALUES (?, ?, ?)")
          .run(projectId, ticketId, normTag);

        // Only write audit if the tag was actually inserted (not a duplicate).
        if (result.changes === 1) {
          writeAudit(db, {
            projectId,
            ticketId,
            field: "tag",
            oldValue: null,
            newValue: normTag,
            changedAt,
          });
        }
      });

      doInsert();

      const tagRows = db
        .prepare(
          "SELECT tag FROM tags WHERE project_id = ? AND ticket_id = ? ORDER BY tag",
        )
        .all(projectId, ticketId) as Array<{ tag: string }>;

      return { tags: tagRows.map((r) => r.tag) };
    },
  };
}
