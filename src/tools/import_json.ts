import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { validateImportFile } from "../lib/import-format.js";
import { insertBatch, type ImportCounts } from "../lib/insert-batch.js";
import type { Tool } from "./types.js";

export type { ImportCounts };

export interface ImportJsonArgs {
  project: string;
  file: string;
  dry_run?: boolean;
  force?: boolean;
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

      // Step 4: delegate the insert core (duplicate detection, dry_run, the
      // 3-pass transaction, recount + warning merge) to insertBatch.
      const { created: _created, ...result } = insertBatch(db, {
        projectId,
        tickets: parsed.tickets,
        relations: parsed.relations ?? [],
        force,
        dryRun,
      });

      return result;
    },
  };
}
