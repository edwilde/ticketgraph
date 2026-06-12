import type Database from "better-sqlite3";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requireProject } from "../lib/projects.js";
import { NO_ROOTS, type GetClientRoots } from "../lib/roots.js";
import { sanitiseFtsQuery } from "../lib/fts.js";
import type { Tool } from "./types.js";

const DEFAULT_STATUS_FILTER = ["open", "in_progress", "blocked"];
const VALID_STATUSES = new Set(["open", "in_progress", "blocked", "done", "deferred"]);
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_SNIPPET_LENGTH = 16;
const MAX_SNIPPET_LENGTH = 64;

export interface SearchArgs {
  project?: string;
  q: string;
  status?: string | string[];
  priority?: string;
  type?: string;
  epic?: string;
  include_done?: boolean;
  limit?: number;
  snippet_length?: number;
}

export interface SearchHit {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  type: string;
  snippet: string;
  score: number;
}

export interface SearchResult {
  project: string;
  count: number;
  hits: SearchHit[];
}

export function makeSearchTool(db: Database.Database, getClientRoots: GetClientRoots = NO_ROOTS): Tool<SearchArgs, SearchResult> {
  return {
    name: "tickets.search",
    description:
      "Full-text search over ticket titles and descriptions using FTS5 BM25 ranking. " +
      "Title is weighted 3× over description. Returns up to limit (default 10, max 50) hits " +
      "with 240-char description snippets. Default status filter: open, in_progress, blocked. " +
      "Pass include_done: true to include done/deferred tickets. " +
      "score is the raw BM25 value — lower (more negative) is a better match.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        q: { type: "string" },
        status: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        priority: { type: "string" },
        type: { type: "string" },
        epic: { type: "string" },
        include_done: { type: "boolean" },
        limit: { type: "number" },
        snippet_length: { type: "number" },
      },
      additionalProperties: false,
      required: ["q"],
    },

    parseArgs(raw: unknown): SearchArgs {
      if (typeof raw !== "object" || raw === null) {
        throw new McpError(ErrorCode.InvalidParams, "Arguments must be an object.");
      }
      const r = raw as Record<string, unknown>;

      if (typeof r["q"] !== "string" || r["q"].trim() === "") {
        throw new McpError(ErrorCode.InvalidParams, "search query is empty");
      }

      const limit = r["limit"] !== undefined ? Number(r["limit"]) : DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1) {
        throw new McpError(ErrorCode.InvalidParams, "limit must be a positive integer.");
      }
      const clampedLimit = Math.min(limit, MAX_LIMIT);

      const snippetLength =
        r["snippet_length"] !== undefined ? Number(r["snippet_length"]) : DEFAULT_SNIPPET_LENGTH;
      if (!Number.isInteger(snippetLength) || snippetLength < 1) {
        throw new McpError(ErrorCode.InvalidParams, "snippet_length must be a positive integer.");
      }
      const clampedSnippetLength = Math.min(snippetLength, MAX_SNIPPET_LENGTH);

      // Validate status against the known statuses. Unlike list, search has no
      // 'all'/'outstanding' sentinels — it controls done/deferred via the
      // include_done flag — so a string status must be a concrete status and an
      // array must contain only concrete statuses. This closes the footgun
      // where a typo (e.g. "outstandng") silently matched zero rows via the
      // `t.status = ?` clause instead of failing loudly (mirrors list.ts).
      const statusRaw = r["status"];
      if (typeof statusRaw === "string") {
        if (!VALID_STATUSES.has(statusRaw)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `status must be one of: ${[...VALID_STATUSES].join(", ")} (got '${statusRaw}')`,
          );
        }
      } else if (Array.isArray(statusRaw)) {
        for (const s of statusRaw) {
          if (typeof s !== "string" || !VALID_STATUSES.has(s)) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `status array must contain only: ${[...VALID_STATUSES].join(", ")} (got '${String(s)}')`,
            );
          }
        }
      }

      return {
        project: typeof r["project"] === "string" ? r["project"] : undefined,
        q: r["q"] as string,
        status: r["status"] as string | string[] | undefined,
        priority: typeof r["priority"] === "string" ? r["priority"] : undefined,
        type: typeof r["type"] === "string" ? r["type"] : undefined,
        epic: typeof r["epic"] === "string" ? r["epic"] : undefined,
        include_done: typeof r["include_done"] === "boolean" ? r["include_done"] : undefined,
        limit: clampedLimit,
        snippet_length: clampedSnippetLength,
      };
    },

    async handle(args: SearchArgs): Promise<SearchResult> {
      const project = await requireProject(db, { project: args.project, allowAll: true }, getClientRoots);
      const isAll = project.id === "all";

      const matchExpr = sanitiseFtsQuery(args.q);
      if (!matchExpr) {
        throw new McpError(ErrorCode.InvalidParams, "search query is empty");
      }

      const snippetLength = args.snippet_length ?? DEFAULT_SNIPPET_LENGTH;
      const limit = args.limit ?? DEFAULT_LIMIT;

      // Build WHERE clauses and params.
      // Param order: snippet_length, MATCH expr, [project_id], [status params], [priority], [type], [epic], limit
      const whereClauses: string[] = [];
      const whereParams: unknown[] = [];

      // FTS MATCH is always first in WHERE (after snippet_length and match expr are bound).
      whereClauses.push("tickets_fts MATCH ?");
      whereParams.push(matchExpr);

      // Project filter.
      if (!isAll) {
        whereClauses.push("t.project_id = ?");
        whereParams.push(project.id);
      }

      // Status filter logic:
      // - explicit status → use it
      // - include_done && no explicit status → no status filter
      // - default → open, in_progress, blocked
      const statusArg = args.status;
      const includeDone = args.include_done ?? false;

      if (Array.isArray(statusArg) && statusArg.length > 0) {
        const placeholders = statusArg.map(() => "?").join(", ");
        whereClauses.push(`t.status IN (${placeholders})`);
        whereParams.push(...statusArg);
      } else if (typeof statusArg === "string") {
        whereClauses.push("t.status = ?");
        whereParams.push(statusArg);
      } else if (!includeDone) {
        // Default: exclude done/deferred.
        const placeholders = DEFAULT_STATUS_FILTER.map(() => "?").join(", ");
        whereClauses.push(`t.status IN (${placeholders})`);
        whereParams.push(...DEFAULT_STATUS_FILTER);
      }
      // else: include_done: true with no explicit status → no status filter

      if (args.priority !== undefined) {
        whereClauses.push("t.priority = ?");
        whereParams.push(args.priority);
      }
      if (args.type !== undefined) {
        whereClauses.push("t.type = ?");
        whereParams.push(args.type);
      }
      if (args.epic !== undefined) {
        whereClauses.push("t.epic = ?");
        whereParams.push(args.epic);
      }

      const whereStr = "WHERE " + whereClauses.join(" AND ");

      // bm25 takes one weight per FTS column, positionally. The table is
      // fts5(project_id UNINDEXED, ticket_id UNINDEXED, title, description),
      // so weights must be supplied for all four columns: the two UNINDEXED
      // columns get 1.0 (ignored — they carry no tokens), title gets 3.0,
      // description gets 1.0. Supplying only two weights would assign them to
      // the UNINDEXED columns and leave title/description at the default 1.0,
      // silently dropping the 3x title boost.
      // snippet_length is the first bound param (positional in snippet()).
      const sql = `
        SELECT t.id, t.title, t.status, t.priority, t.type,
               snippet(tickets_fts, 3, '<mark>', '</mark>', '…', ?) AS snippet,
               bm25(tickets_fts, 1.0, 1.0, 3.0, 1.0) AS score
        FROM tickets_fts
        JOIN tickets t ON t.project_id = tickets_fts.project_id AND t.id = tickets_fts.ticket_id
        ${whereStr}
        ORDER BY bm25(tickets_fts, 1.0, 1.0, 3.0, 1.0) ASC, t.id ASC
        LIMIT ?
      `;

      const allParams = [snippetLength, ...whereParams, limit];
      const rows = db.prepare(sql).all(allParams) as SearchHit[];

      return {
        project: project.id,
        count: rows.length,
        hits: rows,
      };
    },
  };
}
