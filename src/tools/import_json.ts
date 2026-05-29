import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { validateImportFile } from "../lib/import-format.js";
import { writeAudit } from "../lib/audit.js";
import { nowIso } from "../lib/now.js";
import type { Tool } from "./types.js";

export interface ImportJsonArgs {
  project: string;
  file: string;
  dry_run?: boolean;
  force?: boolean;
}

export interface ImportCounts {
  tickets: number;
  relations: number;
  tags: number;
}

export interface ImportJsonResult {
  imported?: boolean;
  dry_run?: boolean;
  counts: ImportCounts;
  warnings: string[];
}

export function makeImportJsonTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<ImportJsonArgs, ImportJsonResult> {
  return {
    name: "tickets.import_json",
    description:
      "Import tickets from a JSON intermediate file. Supports dry_run (validate only) and force (overwrite duplicates). project must be registered and match the file's project_id.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Project id. Must be registered and match the file's project_id.",
        },
        file: {
          type: "string",
          description: "Absolute path to the JSON intermediate file to import.",
        },
        dry_run: {
          type: "boolean",
          description:
            "If true, validate and return counts/warnings without writing to the database.",
        },
        force: {
          type: "boolean",
          description:
            "If true, overwrite tickets with colliding (project_id, id) by deleting them first (cascades relations and tags).",
        },
      },
      required: ["project", "file"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): ImportJsonArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      const project = r["project"];
      if (typeof project !== "string" || project.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "project must be a non-empty string.");
      }

      const file = r["file"];
      if (typeof file !== "string" || file.trim().length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "file must be a non-empty string.");
      }

      return {
        project: project as string,
        file: file as string,
        dry_run: typeof r["dry_run"] === "boolean" ? r["dry_run"] : undefined,
        force: typeof r["force"] === "boolean" ? r["force"] : undefined,
      };
    },

    async handle(args: ImportJsonArgs): Promise<ImportJsonResult> {
      const dryRun = args.dry_run === true;
      const force = args.force === true;

      // Step 1: validate project is registered.
      const projectRow = await requireProject(db, { project: args.project }, getClientRoots);
      const projectId = projectRow.id;

      // Step 2: read and parse the file.
      let rawJson: unknown;
      try {
        const content = readFileSync(args.file, "utf-8");
        rawJson = JSON.parse(content);
      } catch (err) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Failed to read or parse file '${args.file}': ${String(err)}`,
        );
      }

      let parsed;
      try {
        parsed = validateImportFile(rawJson);
      } catch (err) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Import file validation failed: ${String(err)}`,
        );
      }

      // Step 3: assert project_id match.
      if (parsed.project_id !== projectId) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `File is for project '${parsed.project_id}', not '${projectId}'.`,
        );
      }

      const relations = parsed.relations ?? [];

      // Step 4: compute warnings — duplicates and dangling relations.
      const warnings: string[] = [];

      // Find colliding ticket ids.
      const fileIds = new Set(parsed.tickets.map((t) => t.id));
      const collidingIds: string[] = [];
      for (const ticket of parsed.tickets) {
        const existing = db
          .prepare("SELECT id FROM tickets WHERE project_id = ? AND id = ?")
          .get(projectId, ticket.id);
        if (existing) {
          collidingIds.push(ticket.id);
        }
      }

      if (collidingIds.length > 0) {
        warnings.push(
          `Duplicate ticket ids (already in DB): ${collidingIds.join(", ")}`,
        );
      }

      // Find dangling relations: endpoints not in file and not in DB.
      const dbIdSet = new Set<string>();
      const dbRows = db
        .prepare("SELECT id FROM tickets WHERE project_id = ?")
        .all(projectId) as Array<{ id: string }>;
      for (const row of dbRows) {
        dbIdSet.add(row.id);
      }
      const allKnownIds = new Set([...fileIds, ...dbIdSet]);

      const danglingRelations: ImportJsonResult["warnings"] = [];
      for (const rel of relations) {
        if (!allKnownIds.has(rel.from) || !allKnownIds.has(rel.to)) {
          danglingRelations.push(
            `Relation ${rel.from}->${rel.to} (${rel.kind}): endpoint(s) not found — skipped`,
          );
        }
      }
      warnings.push(...danglingRelations);

      // Compute counts.
      const tagCount = parsed.tickets.reduce(
        (sum, t) => sum + (t.tags ? t.tags.length : 0),
        0,
      );
      const validRelationCount = relations.filter(
        (rel) => allKnownIds.has(rel.from) && allKnownIds.has(rel.to),
      ).length;
      const counts: ImportCounts = {
        tickets: parsed.tickets.length,
        relations: validRelationCount,
        tags: tagCount,
      };

      // Step 5: dry_run — return without mutating.
      if (dryRun) {
        return { dry_run: true, counts, warnings };
      }

      // Step 6: if duplicates exist and !force, abort.
      if (collidingIds.length > 0 && !force) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Import aborted: duplicate ticket ids exist in project '${projectId}': ${collidingIds.join(", ")}. Use force: true to overwrite.`,
        );
      }

      // Step 7: write in ONE transaction — 3 passes.
      const skippedRelationWarnings: string[] = [];

      const doImport = db.transaction(() => {
        // Force: delete colliding tickets first (cascades relations/tags).
        if (force && collidingIds.length > 0) {
          const deleteStmt = db.prepare(
            "DELETE FROM tickets WHERE project_id = ? AND id = ?",
          );
          for (const id of collidingIds) {
            deleteStmt.run(projectId, id);
          }
        }

        // Pass 1: insert all tickets with parent_id = NULL, plus tags + _created audit.
        const insertTicket = db.prepare(
          `INSERT INTO tickets (id, project_id, title, description, status, priority, type, effort, epic, parent_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        );
        const insertTag = db.prepare(
          "INSERT INTO tags (project_id, ticket_id, tag) VALUES (?, ?, ?)",
        );

        for (const ticket of parsed.tickets) {
          const created_at = ticket.created_at ?? nowIso();
          const status = ticket.status ?? "open";
          const type = ticket.type ?? "task";
          const description = ticket.description ?? "";
          const created_by = ticket.created_by ?? "claude";

          try {
            insertTicket.run(
              ticket.id,
              projectId,
              ticket.title,
              description,
              status,
              ticket.priority ?? null,
              type,
              ticket.effort ?? null,
              ticket.epic ?? null,
              created_by,
              created_at,
            );
          } catch (err) {
            const msg = String(err);
            if (msg.includes("CHECK constraint failed") || msg.includes("SQLITE_CONSTRAINT_CHECK")) {
              throw new McpError(
                ErrorCode.InvalidParams,
                `Invalid field value for ticket ${ticket.id}: ${msg}`,
              );
            }
            throw new McpError(ErrorCode.InvalidParams, `Insert failed for ticket ${ticket.id}: ${msg}`);
          }

          // Insert tags (normalised).
          const tags = ticket.tags ?? [];
          const normalisedTags = [...new Set(tags.map((t) => t.trim().toLowerCase()))].filter(
            (t) => t.length > 0,
          );
          for (const tag of normalisedTags) {
            insertTag.run(projectId, ticket.id, tag);
          }

          // Back-dated _created audit row.
          writeAudit(db, {
            projectId,
            ticketId: ticket.id,
            field: "_created",
            oldValue: null,
            newValue: ticket.id,
            changedAt: created_at,
          });

          // Set closed_at if status is terminal and closed_at is provided.
          if (ticket.closed_at != null) {
            db.prepare(
              "UPDATE tickets SET closed_at = ? WHERE project_id = ? AND id = ?",
            ).run(ticket.closed_at, projectId, ticket.id);
          }
        }

        // Pass 2: update parent_id for tickets that had one.
        const updateParent = db.prepare(
          "UPDATE tickets SET parent_id = ? WHERE project_id = ? AND id = ?",
        );
        for (const ticket of parsed.tickets) {
          if (ticket.parent_id != null) {
            updateParent.run(ticket.parent_id, projectId, ticket.id);
          }
        }

        // Pass 3: insert valid relations; skip dangling ones with a warning.
        // Re-compute known ids inside transaction (includes freshly inserted tickets).
        const freshIds = new Set(parsed.tickets.map((t) => t.id));
        const existingDbIds = new Set(
          (db
            .prepare("SELECT id FROM tickets WHERE project_id = ?")
            .all(projectId) as Array<{ id: string }>).map((r) => r.id),
        );
        const allIds = new Set([...freshIds, ...existingDbIds]);

        const insertRelation = db.prepare(
          `INSERT OR IGNORE INTO relations (project_id, from_id, to_id, kind, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );

        const now = nowIso();
        for (const rel of relations) {
          if (!allIds.has(rel.from) || !allIds.has(rel.to)) {
            skippedRelationWarnings.push(
              `Relation ${rel.from}->${rel.to} (${rel.kind}): endpoint(s) not found — skipped`,
            );
            continue;
          }
          insertRelation.run(projectId, rel.from, rel.to, rel.kind, rel.note ?? null, now);
          writeAudit(db, {
            projectId,
            ticketId: rel.from,
            field: `relation:${rel.kind}`,
            oldValue: null,
            newValue: `${rel.from}->${rel.to}`,
            changedAt: now,
          });
        }
      });

      doImport();

      // Merge skipped-relation warnings captured inside the transaction.
      // (Remove the pre-computed dangling warnings which were based on pre-import DB state,
      //  replace with the authoritative ones from inside the transaction.)
      const finalWarnings = warnings.filter(
        (w) => !w.startsWith("Relation ") || !w.endsWith("— skipped"),
      );
      finalWarnings.push(...skippedRelationWarnings);

      // Recount actual tags inserted (after normalisation/dedup).
      const actualTagCount = (
        db
          .prepare(
            `SELECT COUNT(*) as n FROM tags WHERE project_id = ? AND ticket_id IN (${parsed.tickets.map(() => "?").join(",")})`,
          )
          .get(projectId, ...parsed.tickets.map((t) => t.id)) as { n: number }
      ).n;

      const actualRelationCount = (
        db
          .prepare("SELECT COUNT(*) as n FROM relations WHERE project_id = ?")
          .get(projectId) as { n: number }
      ).n;

      return {
        imported: true,
        counts: {
          tickets: parsed.tickets.length,
          relations: relations.length - skippedRelationWarnings.length,
          tags: actualTagCount,
        },
        warnings: finalWarnings,
      };
    },
  };
}
