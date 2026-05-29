import type Database from "better-sqlite3";
import { getPackageVersion } from "../version.js";
import type { Tool } from "./types.js";

export type PingArgs = Record<string, never>;
export type PingResult = {
  ok: true;
  version: string;
  db_path: string;
  schema_version: number;
};

export function makePingTool(deps: {
  db: Database.Database;
  dbPath: string;
}): Tool<PingArgs, PingResult> {
  return {
    name: "tickets.ping",
    description:
      "Liveness check. Returns { ok: true, version, db_path, schema_version }.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    parseArgs(_raw: unknown): PingArgs {
      return {};
    },
    async handle(_args: PingArgs): Promise<PingResult> {
      const schema_version = deps.db.pragma("user_version", {
        simple: true,
      }) as number;
      return {
        ok: true,
        version: getPackageVersion(),
        db_path: deps.dbPath,
        schema_version,
      };
    },
  };
}
