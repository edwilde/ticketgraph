import type Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { nowIso } from "../lib/now.js";
import { collectProjectExport } from "../lib/export-collect.js";
import { renderExportMarkdown } from "../lib/export-markdown.js";
import type { Tool } from "./types.js";

export interface ExportArgs {
  project?: string;
  path?: string;
}

export interface ExportResult {
  path: string;
  bytes: number;
  ticket_count: number;
  exported_at: string;
}

export function makeExportTool(
  db: Database.Database,
  getClientRoots: GetClientRoots = NO_ROOTS,
): Tool<ExportArgs, ExportResult> {
  return {
    name: "tickets.export",
    description:
      "Renders the project's tickets to a drift-labelled markdown snapshot. " +
      "The default output path is <root>/.ai/TICKETS.md. " +
      "OVERWRITES the target file if it already exists. " +
      "Pass path to override the destination (absolute paths are used verbatim; " +
      "relative paths resolve under the project root_path). " +
      "Note: ~ is NOT expanded.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        path: { type: "string" },
      },
      additionalProperties: false,
    },

    parseArgs(raw: unknown): ExportArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;
      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        path: typeof r["path"] === "string" ? r["path"] : undefined,
      };
    },

    async handle(args: ExportArgs): Promise<ExportResult> {
      const project = await requireProject(db, { project: args.project }, getClientRoots);

      // Resolve the output path.
      let target: string;
      if (args.path !== undefined) {
        target = path.isAbsolute(args.path)
          ? args.path
          : path.resolve(project.root_path, args.path);
      } else {
        target = path.resolve(project.root_path, ".ai/TICKETS.md");
      }

      const exportedAt = nowIso();
      const { tickets, statusCounts } = collectProjectExport(db, project.id);
      const body = renderExportMarkdown({ projectId: project.id, exportedAt, tickets, statusCounts });
      const finalBody = body.endsWith("\n") ? body : body + "\n";

      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, finalBody, "utf-8");

      return {
        path: target,
        bytes: Buffer.byteLength(finalBody, "utf-8"),
        ticket_count: tickets.length,
        exported_at: exportedAt,
      };
    },
  };
}
