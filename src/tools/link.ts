import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { writeAudit } from "../lib/audit.js";
import { nowIso } from "../lib/now.js";
import { isKnownKind, ticketExists, KNOWN_RELATION_KINDS } from "../lib/relations.js";
import type { Tool } from "./types.js";

export interface LinkArgs {
  project?: string;
  from: string;
  to: string;
  kind: string;
  note?: string;
  force?: boolean;
}

export interface LinkResult {
  from: string;
  to: string;
  kind: string;
  note: string | null;
  created_at: string;
}

export function makeLinkTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<LinkArgs, LinkResult> {
  return {
    name: "tickets.link",
    description:
      "Create a directed typed relation between two tickets. " +
      "Known kinds: blocks, follows_up, supersedes, relates_to. " +
      "Pass force: true to use a custom kind.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id. Omit to resolve from cwd." },
        from: { type: "string", description: "Source ticket id (the active party)." },
        to: { type: "string", description: "Target ticket id." },
        kind: { type: "string", description: "Relation kind (e.g. blocks, follows_up, supersedes, relates_to)." },
        note: { type: "string", description: "Optional free-text note." },
        force: { type: "boolean", description: "Allow unknown relation kinds." },
      },
      required: ["from", "to", "kind"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): LinkArgs {
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
        note: typeof r["note"] === "string" ? r["note"] : undefined,
        force: typeof r["force"] === "boolean" ? r["force"] : undefined,
      };
    },

    async handle(args: LinkArgs): Promise<LinkResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;

      // Reject self-relations.
      if (args.from === args.to) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `A ticket cannot have a relation to itself (from === to: '${args.from}').`,
        );
      }

      // Validate kind unless force is set.
      if (!args.force && !isKnownKind(args.kind)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown relation kind '${args.kind}'. Known: ${KNOWN_RELATION_KINDS.join(", ")}. Pass force: true to use anyway.`,
        );
      }

      // Validate both tickets exist in the project.
      if (!ticketExists(db, projectId, args.from)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Ticket '${projectId}/${args.from}' not found.`,
        );
      }
      if (!ticketExists(db, projectId, args.to)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Ticket '${projectId}/${args.to}' not found.`,
        );
      }

      const created_at = nowIso();
      const note = args.note ?? null;

      const doInsert = db.transaction(() => {
        try {
          db.prepare(
            `INSERT INTO relations (project_id, from_id, to_id, kind, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(projectId, args.from, args.to, args.kind, note, created_at);
        } catch (err) {
          const msg = String(err);
          if (msg.includes("SQLITE_CONSTRAINT_PRIMARYKEY") || msg.includes("UNIQUE constraint failed")) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Relation ${args.from}-${args.kind}->${args.to} already exists.`,
            );
          }
          throw new McpError(ErrorCode.InvalidParams, `Insert failed: ${msg}`);
        }

        writeAudit(db, {
          projectId,
          ticketId: args.from,
          field: `relation:${args.kind}`,
          oldValue: null,
          newValue: `${args.from}->${args.to}`,
          changedAt: created_at,
        });
      });

      doInsert();

      return { from: args.from, to: args.to, kind: args.kind, note, created_at };
    },
  };
}
