import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import type { Tool } from "./types.js";

export interface GetArgs {
  project?: string;
  id?: string;
  ids?: string[];
  include_audit?: boolean;
}

interface AuditEntry {
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
}

interface RelationRow {
  from_id: string;
  to_id: string;
  kind: string;
  note: string | null;
}

interface TicketFull {
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
  tags: string[];
  relations: {
    outgoing: Record<string, Array<{ id: string; note: string | null }>>;
    incoming: Record<string, Array<{ id: string; note: string | null }>>;
  };
  recent_audit?: AuditEntry[];
}

export type GetResult =
  | { ticket: TicketFull | null }
  | { tickets: Array<TicketFull | null> };

export function makeGetTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<GetArgs, GetResult> {
  return {
    name: "tickets.get",
    description:
      "Get one or more full tickets including tags and relations. " +
      "Pass id for a single ticket, or ids (array, max 10) for multiple. " +
      "Recent audit history is opt-in via include_audit.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        id: { type: "string" },
        ids: { type: "array", items: { type: "string" }, maxItems: 10 },
        include_audit: {
          type: "boolean",
          description: "Include each ticket's recent audit history (last 10 entries). Off by default.",
        },
      },
      additionalProperties: false,
    },

    parseArgs(raw: unknown): GetArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      const id = r["id"];
      const ids = r["ids"];

      if (id === undefined && ids === undefined) {
        throw new McpError(ErrorCode.InvalidParams, "Either id or ids must be supplied.");
      }

      if (ids !== undefined) {
        if (!Array.isArray(ids)) {
          throw new McpError(ErrorCode.InvalidParams, "ids must be an array.");
        }
        if (ids.length > 10) {
          throw new McpError(ErrorCode.InvalidParams, "ids array cannot exceed 10 items.");
        }
        if (ids.some((i) => typeof i !== "string")) {
          throw new McpError(ErrorCode.InvalidParams, "All ids must be strings.");
        }
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        id: typeof id === "string" ? id : undefined,
        ids: Array.isArray(ids) ? (ids as string[]) : undefined,
        include_audit: r["include_audit"] === true,
      };
    },

    async handle(args: GetArgs): Promise<GetResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;

      // ids wins if both supplied.
      const isBatch = args.ids !== undefined;
      const lookupIds = isBatch ? args.ids! : [args.id!];

      const results: Array<TicketFull | null> = lookupIds.map((ticketId) =>
        fetchTicket(db, projectId, ticketId, args.include_audit === true),
      );

      if (isBatch) {
        return { tickets: results };
      }

      // Single id — error on miss.
      const ticket = results[0]!;
      if (ticket === null) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Ticket ${projectId}/${args.id!} not found.`,
        );
      }
      return { ticket };
    },
  };
}

function fetchTicket(
  db: Database.Database,
  projectId: string,
  ticketId: string,
  includeAudit: boolean,
): TicketFull | null {
  const row = db
    .prepare("SELECT * FROM tickets WHERE project_id = ? AND id = ?")
    .get(projectId, ticketId) as Record<string, unknown> | undefined;

  if (!row) return null;

  // Tags.
  const tagRows = db
    .prepare("SELECT tag FROM tags WHERE project_id = ? AND ticket_id = ?")
    .all(projectId, ticketId) as Array<{ tag: string }>;
  const tags = tagRows.map((t) => t.tag);

  // Relations.
  const relRows = db
    .prepare(
      "SELECT from_id, to_id, kind, note FROM relations WHERE project_id = ? AND (from_id = ? OR to_id = ?)",
    )
    .all(projectId, ticketId, ticketId) as RelationRow[];

  const outgoing: Record<string, Array<{ id: string; note: string | null }>> = {};
  const incoming: Record<string, Array<{ id: string; note: string | null }>> = {};

  for (const rel of relRows) {
    if (rel.from_id === ticketId) {
      if (!outgoing[rel.kind]) outgoing[rel.kind] = [];
      outgoing[rel.kind]!.push({ id: rel.to_id, note: rel.note });
    } else {
      if (!incoming[rel.kind]) incoming[rel.kind] = [];
      incoming[rel.kind]!.push({ id: rel.from_id, note: rel.note });
    }
  }

  const ticket: TicketFull = {
    id: row["id"] as string,
    project_id: row["project_id"] as string,
    title: row["title"] as string,
    description: row["description"] as string,
    status: row["status"] as string,
    priority: (row["priority"] as string | null) ?? null,
    type: row["type"] as string,
    effort: (row["effort"] as number | null) ?? null,
    epic: (row["epic"] as string | null) ?? null,
    parent_id: (row["parent_id"] as string | null) ?? null,
    created_by: (row["created_by"] as string | null) ?? null,
    created_at: row["created_at"] as string,
    closed_at: (row["closed_at"] as string | null) ?? null,
    tags,
    relations: { outgoing, incoming },
  };

  // Recent audit (last 10, descending) — opt-in; skip the query when not requested.
  if (includeAudit) {
    ticket.recent_audit = db
      .prepare(
        "SELECT field, old_value, new_value, changed_at FROM audit_log WHERE project_id = ? AND ticket_id = ? ORDER BY changed_at DESC LIMIT 10",
      )
      .all(projectId, ticketId) as AuditEntry[];
  }

  return ticket;
}
