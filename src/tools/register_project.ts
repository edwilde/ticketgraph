import type Database from "better-sqlite3";
import { isAbsolute, normalize } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { RESERVED_PROJECT_IDS } from "../lib/projects.js";
import { nowIso } from "../lib/now.js";
import type { Tool } from "./types.js";

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

export interface RegisterProjectArgs {
  id: string;
  display_name: string;
  root_path: string;
}

export interface RegisterProjectResult {
  id: string;
  display_name: string;
  root_path: string;
  created_at: string;
}

export function makeRegisterProjectTool(db: Database.Database): Tool<RegisterProjectArgs, RegisterProjectResult> {
  return {
    name: "tickets.register_project",
    description:
      "Register a project with a unique id, display name, and root path. " +
      "The root_path must be an existing directory.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Project id, e.g. 'demo'. Must match /^[a-z][a-z0-9_-]*$/." },
        display_name: { type: "string", description: "Human-readable project name." },
        root_path: { type: "string", description: "Absolute path to the project's root directory." },
      },
      required: ["id", "display_name", "root_path"],
      additionalProperties: false,
    },

    parseArgs(raw: unknown): RegisterProjectArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      const id = r["id"];
      const display_name = r["display_name"];
      const root_path = r["root_path"];

      if (typeof id !== "string" || id.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "id must be a non-empty string.");
      }
      if (typeof display_name !== "string" || display_name.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "display_name must be a non-empty string.");
      }
      if (typeof root_path !== "string" || root_path.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, "root_path must be a non-empty string.");
      }

      return { id, display_name, root_path };
    },

    async handle(args: RegisterProjectArgs): Promise<RegisterProjectResult> {
      const { id, display_name } = args;

      // Validate id constraints.
      if (RESERVED_PROJECT_IDS.has(id)) {
        throw new McpError(ErrorCode.InvalidParams, `Project id '${id}' is reserved.`);
      }
      if (!PROJECT_ID_PATTERN.test(id)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Project id must match /^[a-z][a-z0-9_-]*$/.",
        );
      }

      // Validate root_path.
      if (!isAbsolute(args.root_path)) {
        throw new McpError(ErrorCode.InvalidParams, `root_path must be an absolute path: ${args.root_path}`);
      }

      let root_path: string;
      try {
        const stat = statSync(args.root_path);
        if (!stat.isDirectory()) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `root_path is not a directory: ${args.root_path}`,
          );
        }
        root_path = realpathSync(args.root_path);
      } catch (err) {
        if (err instanceof McpError) throw err;
        throw new McpError(
          ErrorCode.InvalidParams,
          `root_path does not exist: ${args.root_path}`,
        );
      }

      const created_at = nowIso();

      try {
        db.prepare(
          "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
        ).run(id, display_name, root_path, created_at);
      } catch (err) {
        const msg = String(err);
        if (msg.includes("SQLITE_CONSTRAINT_PRIMARYKEY") || msg.includes("UNIQUE constraint failed: projects.id")) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Project '${id}' is already registered.`,
          );
        }
        if (msg.includes("SQLITE_CONSTRAINT_UNIQUE") || msg.includes("UNIQUE constraint failed: projects.root_path")) {
          // Look up the existing project for a helpful message.
          const existing = db
            .prepare("SELECT id FROM projects WHERE root_path = ?")
            .get(root_path) as { id: string } | undefined;
          const existingId = existing?.id ?? "unknown";
          throw new McpError(
            ErrorCode.InvalidParams,
            `root_path '${root_path}' is already registered to '${existingId}'.`,
          );
        }
        throw new McpError(ErrorCode.InvalidParams, `Failed to register project: ${msg}`);
      }

      return { id, display_name, root_path, created_at };
    },
  };
}
