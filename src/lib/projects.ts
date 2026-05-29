import type Database from "better-sqlite3";
import { realpathSync } from "node:fs";
import path from "node:path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { GetClientRoots } from "./roots.js";

export const RESERVED_PROJECT_IDS = new Set(["all", "current"]);

/**
 * Resolve a path to its canonical real form, walking up to the nearest
 * existing ancestor when the full path does not exist on disk.
 * This handles subdirectory cwd values that don't exist yet.
 */
function resolveExistingPath(inputPath: string): string {
  const normalised = path.normalize(inputPath);
  // Walk up until we find an existing ancestor, then re-append the suffix.
  const parts = normalised.split(path.sep);
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join(path.sep) || path.sep;
    try {
      const real = realpathSync(candidate);
      const suffix = parts.slice(i).join(path.sep);
      return suffix ? real + path.sep + suffix : real;
    } catch {
      // not resolvable at this depth — try shorter
    }
  }
  return normalised;
}

export interface ProjectRow {
  id: string;
  root_path: string;
}

/**
 * Resolve the active project from a candidate dir using longest-prefix matching.
 * Returns null if no project root_path is a prefix of dir.
 */
export function resolveProjectForDir(
  db: Database.Database,
  dir: string,
): ProjectRow | null {
  const realDir = resolveExistingPath(dir);

  const rows = db
    .prepare("SELECT id, root_path FROM projects ORDER BY length(root_path) DESC")
    .all() as ProjectRow[];

  for (const row of rows) {
    let realRootPath: string;
    try {
      realRootPath = realpathSync(row.root_path);
    } catch {
      realRootPath = row.root_path;
    }
    if (realDir === realRootPath || realDir.startsWith(realRootPath + path.sep)) {
      return row;
    }
  }
  return null;
}

/**
 * @deprecated Use resolveProjectForDir instead.
 */
export function resolveProjectFromCwd(
  db: Database.Database,
  cwd: string,
): ProjectRow | null {
  return resolveProjectForDir(db, cwd);
}

export interface RequireProjectOpts {
  project?: string;
  allowAll?: boolean;
}

/**
 * Resolve the project from opts.project (explicit override) or from client roots + cwd.
 * Throws McpError(InvalidParams) on failure.
 * Pass allowAll: true on read tools that accept project: "all".
 */
export async function requireProject(
  db: Database.Database,
  opts: RequireProjectOpts,
  getClientRoots: GetClientRoots,
): Promise<ProjectRow> {
  const explicit = opts.project;

  if (explicit !== undefined) {
    if (explicit === "all") {
      if (opts.allowAll) {
        // Caller handles the "all" case separately — return sentinel.
        return { id: "all", root_path: "" };
      }
      throw new McpError(
        ErrorCode.InvalidParams,
        'project: "all" is not allowed for this tool.',
      );
    }

    if (RESERVED_PROJECT_IDS.has(explicit)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Project id '${explicit}' is reserved.`,
      );
    }

    // Validate the explicit id exists.
    const row = db
      .prepare("SELECT id, root_path FROM projects WHERE id = ?")
      .get(explicit) as ProjectRow | undefined;
    if (!row) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Project '${explicit}' is not registered. Register it with tickets.register_project.`,
      );
    }
    return row;
  }

  // No explicit project — resolve from client roots then cwd.
  const roots = await getClientRoots();
  const candidates = [...roots, process.cwd()];

  for (const candidate of candidates) {
    const resolved = resolveProjectForDir(db, candidate);
    if (resolved) return resolved;
  }

  const rootsStr = roots.length > 0 ? roots.join(", ") : "(none)";
  const cwd = process.cwd();
  throw new McpError(
    ErrorCode.InvalidParams,
    `No project matches the current workspace (roots: [${rootsStr}], cwd: ${cwd}). Register one with tickets.register_project or pass an explicit project.`,
  );
}
