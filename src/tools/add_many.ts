import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { inferNextIds } from "../lib/numbering.js";
import { insertBatch } from "../lib/insert-batch.js";
import type { ImportTicket, ImportRelation } from "../lib/import-format.js";
import type { Tool } from "./types.js";

const VALID_STATUSES = new Set(["open", "in_progress", "blocked", "done", "deferred"]);
const VALID_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const VALID_TYPES = new Set(["task", "bug", "spike", "followup", "umbrella"]);
const VALID_KINDS = new Set(["blocks", "follows_up", "supersedes", "relates_to"]);

export interface AddTicketInput {
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

export interface AddManyRelation {
  from: string;
  to: string;
  kind: string;
  note?: string | null;
}

export interface AddManyArgs {
  project?: string;
  tickets: AddTicketInput[];
  relations?: AddManyRelation[];
}

export interface AddManyResult {
  created: string[];
  count: number;
  warnings?: string[];
}

export function makeAddManyTool(
  db: Database.Database,
  getClientRoots: GetClientRoots = NO_ROOTS,
): Tool<AddManyArgs, AddManyResult> {
  return {
    name: "tickets.add_many",
    description:
      "Create many tickets (and optional relations) in ONE transaction. Returns the created ticket ids (not full rows). Size each ticket as you log it: set `effort` to a Fibonacci story-point value (1, 2, 3, 5, 8, 13) per the effort-field scale, leaving it unset only for genuinely unknown scope. All-or-nothing: one invalid ticket rolls back the whole batch. Tickets without an id have ids auto-inferred from the project's existing ticket ids; auto-id'd tickets CANNOT be referenced as a parent_id or relation endpoint within the same call (their ids aren't known at author time) — give any referenced ticket an explicit id.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project id. Omit to resolve from cwd." },
        tickets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Ticket id. Omit to auto-generate." },
              title: { type: "string", description: "Ticket title (required)." },
              description: { type: "string" },
              status: { type: "string", enum: ["open", "in_progress", "blocked", "done", "deferred"] },
              priority: { type: "string", enum: ["P0", "P1", "P2", "P3"], nullable: true },
              type: { type: "string", enum: ["task", "bug", "spike", "followup", "umbrella"] },
              epic: { type: "string", nullable: true },
              parent_id: { type: "string", nullable: true },
              effort: {
                type: "number",
                enum: [1, 2, 3, 5, 8, 13],
                nullable: true,
                description:
                  "Fibonacci story points, estimated at creation. 1=trivial (~15 min); 2=small; 3=a normal day's work (default when scope is known); 5=meaty (~half a day); 8=big (~full day); 13=split it first. Null = not sized yet (prefer null over a wrong guess for spikes/unbounded work; umbrellas stay null).",
              },
              created_by: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
        relations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              kind: { type: "string", enum: ["blocks", "follows_up", "supersedes", "relates_to"] },
              note: { type: "string", nullable: true },
            },
            required: ["from", "to", "kind"],
            additionalProperties: false,
          },
        },
      },
      required: ["tickets"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): AddManyArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      const rawTickets = r["tickets"];
      if (!Array.isArray(rawTickets) || rawTickets.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "tickets must be a non-empty array.");
      }

      const idPositions = new Map<string, number>();

      const tickets: AddTicketInput[] = rawTickets.map((t, i) => {
        if (typeof t !== "object" || t === null || Array.isArray(t)) {
          throw new McpError(ErrorCode.InvalidParams, `tickets[${i}] must be an object.`);
        }
        const tk = t as Record<string, unknown>;

        const title = tk["title"];
        if (typeof title !== "string" || title.trim().length === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `tickets[${i}].title must be a non-empty string.`,
          );
        }

        const status = tk["status"];
        if (status !== undefined && (typeof status !== "string" || !VALID_STATUSES.has(status))) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `tickets[${i}].status must be one of: ${[...VALID_STATUSES].join(", ")}`,
          );
        }

        const type = tk["type"];
        if (type !== undefined && (typeof type !== "string" || !VALID_TYPES.has(type))) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `tickets[${i}].type must be one of: ${[...VALID_TYPES].join(", ")}`,
          );
        }

        const priority = tk["priority"];
        if (priority != null && (typeof priority !== "string" || !VALID_PRIORITIES.has(priority))) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `tickets[${i}].priority must be one of: ${[...VALID_PRIORITIES].join(", ")}`,
          );
        }

        const tags = tk["tags"];
        if (tags !== undefined && !Array.isArray(tags)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `tickets[${i}].tags must be an array of strings.`,
          );
        }
        if (Array.isArray(tags) && tags.some((tag) => typeof tag !== "string")) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `tickets[${i}].tags must be an array of strings.`,
          );
        }

        const id = tk["id"];
        if (id !== undefined && typeof id !== "string") {
          throw new McpError(ErrorCode.InvalidParams, `tickets[${i}].id must be a string.`);
        }
        const parent_id = tk["parent_id"];
        if (parent_id != null && typeof parent_id !== "string") {
          throw new McpError(ErrorCode.InvalidParams, `tickets[${i}].parent_id must be a string.`);
        }
        const epic = tk["epic"];
        if (epic != null && typeof epic !== "string") {
          throw new McpError(ErrorCode.InvalidParams, `tickets[${i}].epic must be a string.`);
        }
        const created_by = tk["created_by"];
        if (created_by !== undefined && typeof created_by !== "string") {
          throw new McpError(
            ErrorCode.InvalidParams,
            `tickets[${i}].created_by must be a string.`,
          );
        }
        const description = tk["description"];
        if (description !== undefined && typeof description !== "string") {
          throw new McpError(
            ErrorCode.InvalidParams,
            `tickets[${i}].description must be a string.`,
          );
        }

        if (typeof id === "string") {
          const prev = idPositions.get(id);
          if (prev !== undefined) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Duplicate ticket id '${id}' at positions ${prev} and ${i}.`,
            );
          }
          idPositions.set(id, i);
        }

        return {
          ...(typeof id === "string" ? { id } : {}),
          title,
          ...(description !== undefined ? { description: description as string } : {}),
          ...(status !== undefined ? { status: status as string } : {}),
          ...(priority != null ? { priority: priority as string } : {}),
          ...(type !== undefined ? { type: type as string } : {}),
          ...(epic != null ? { epic: epic as string } : {}),
          ...(parent_id != null ? { parent_id: parent_id as string } : {}),
          ...(tk["effort"] != null ? { effort: tk["effort"] as number } : {}),
          ...(created_by !== undefined ? { created_by: created_by as string } : {}),
          ...(Array.isArray(tags) ? { tags: tags as string[] } : {}),
        };
      });

      const rawRelations = r["relations"];
      let relations: AddManyRelation[] | undefined;
      if (rawRelations !== undefined) {
        if (!Array.isArray(rawRelations)) {
          throw new McpError(ErrorCode.InvalidParams, "relations must be an array.");
        }
        relations = rawRelations.map((rel, j) => {
          if (typeof rel !== "object" || rel === null || Array.isArray(rel)) {
            throw new McpError(ErrorCode.InvalidParams, `relations[${j}] must be an object.`);
          }
          const rv = rel as Record<string, unknown>;

          if (typeof rv["from"] !== "string" || rv["from"].trim().length === 0) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `relations[${j}].from must be a non-empty string.`,
            );
          }
          if (typeof rv["to"] !== "string" || rv["to"].trim().length === 0) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `relations[${j}].to must be a non-empty string.`,
            );
          }
          if (typeof rv["kind"] !== "string" || !VALID_KINDS.has(rv["kind"])) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `relations[${j}].kind must be one of: ${[...VALID_KINDS].join(", ")}`,
            );
          }
          const note = rv["note"];
          if (note != null && typeof note !== "string") {
            throw new McpError(
              ErrorCode.InvalidParams,
              `relations[${j}].note must be a string or null.`,
            );
          }

          return {
            from: rv["from"] as string,
            to: rv["to"] as string,
            kind: rv["kind"] as string,
            ...(note !== undefined ? { note: note as string | null } : {}),
          };
        });
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        tickets,
        ...(relations !== undefined ? { relations } : {}),
      };
    },

    async handle(args: AddManyArgs): Promise<AddManyResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = project.id;

      // --- No `await` past this point: id inference and the insert transaction
      // must run back-to-back so a concurrent call cannot claim the same ids. ---

      const reserved = new Set(
        args.tickets.filter((t) => t.id !== undefined).map((t) => t.id!),
      );
      const idlessCount = args.tickets.filter((t) => t.id === undefined).length;

      let autoIds: string[];
      try {
        autoIds = inferNextIds(db, projectId, idlessCount, reserved);
      } catch (err) {
        throw new McpError(
          ErrorCode.InvalidParams,
          err instanceof Error ? err.message : String(err),
        );
      }

      let ai = 0;
      const resolvedTickets: ImportTicket[] = args.tickets.map((t) => {
        const id = t.id ?? autoIds[ai++]!;
        return {
          id,
          title: t.title,
          description: t.description ?? "",
          status: t.status ?? "open",
          type: t.type ?? "task",
          created_by: t.created_by ?? "claude",
          priority: t.priority ?? null,
          epic: t.epic ?? null,
          parent_id: t.parent_id ?? null,
          effort: t.effort ?? null,
          tags: t.tags ?? [],
        };
      });

      // Validate parent_id references up front (mirrors tickets.add) so a missing
      // parent yields a clear McpError naming the offending ticket rather than a
      // raw SqliteError from the Pass-2 FOREIGN KEY constraint. Synchronous scan —
      // keeps the infer→insert atomicity invariant (no `await` introduced).
      const batchIds = new Set(resolvedTickets.map((t) => t.id));
      const dbIds = new Set(
        (
          db
            .prepare("SELECT id FROM tickets WHERE project_id = ?")
            .all(projectId) as Array<{ id: string }>
        ).map((r) => r.id),
      );
      for (const t of resolvedTickets) {
        if (t.parent_id != null && !batchIds.has(t.parent_id) && !dbIds.has(t.parent_id)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `parent_id '${t.parent_id}' for ticket '${t.id}' does not exist in project '${projectId}' (and is not an explicit-id ticket in this batch).`,
          );
        }
      }

      const relations: ImportRelation[] = (args.relations ?? []).map((r) => ({
        from: r.from,
        to: r.to,
        kind: r.kind,
        ...(r.note !== undefined ? { note: r.note } : {}),
      }));

      const result = insertBatch(db, { projectId, tickets: resolvedTickets, relations });

      return {
        created: result.created,
        count: result.created.length,
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      };
    },
  };
}
