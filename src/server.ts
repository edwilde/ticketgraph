import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// --help gate runs before any SDK import work — fast, dependency-free.
const args = process.argv.slice(2);
if (args.includes("--help")) {
  const __helpDir = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(
    readFileSync(join(__helpDir, "../package.json"), "utf-8"),
  ) as { version: string };
  process.stdout.write(
    `ticketgraph v${pkg.version} — MCP server backing the ticketgraph plugin. See docs/specs/2026-05-28-ticketgraph-design.md.\n`,
  );
  process.exit(0);
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import * as logger from "./logger.js";
import { getPackageVersion } from "./version.js";
import { openDb } from "./db.js";
import { makeClientRootsProvider, type GetClientRoots } from "./lib/roots.js";
import { makePingTool } from "./tools/ping.js";
import { makeRegisterProjectTool } from "./tools/register_project.js";
import { makeAddTool } from "./tools/add.js";
import { makeListTool } from "./tools/list.js";
import { makeGetTool } from "./tools/get.js";
import { makeStatsTool } from "./tools/stats.js";
import { makeUpdateTool } from "./tools/update.js";
import { makeLinkTool } from "./tools/link.js";
import { makeUnlinkTool } from "./tools/unlink.js";
import { makeSetParentTool } from "./tools/set_parent.js";
import { makeAppendToDescriptionTool } from "./tools/append_to_description.js";
import { makeAddTagTool } from "./tools/add_tag.js";
import { makeRemoveTagTool } from "./tools/remove_tag.js";
import { makeSearchTool } from "./tools/search.js";
import { makeNextTool } from "./tools/next.js";
import { makeRelatedTool } from "./tools/related.js";
import { makeBlockersOfTool } from "./tools/blockers_of.js";
import { makeChildrenOfTool } from "./tools/children_of.js";
import { makeChangedSinceTool } from "./tools/changed_since.js";
import { makeValidateTool } from "./tools/validate.js";
import { makeImportJsonTool } from "./tools/import_json.js";
import { makeAddManyTool } from "./tools/add_many.js";
import { makeExportTool } from "./tools/export.js";
import type { AnyTool } from "./tools/types.js";

function makeToolRegistry(deps: {
  db: Database.Database;
  dbPath: string;
  getClientRoots: GetClientRoots;
}): Map<string, AnyTool> {
  const { db, getClientRoots } = deps;
  const tools: AnyTool[] = [
    makePingTool(deps) as unknown as AnyTool,
    makeRegisterProjectTool(db) as unknown as AnyTool,
    makeAddTool(db, getClientRoots) as unknown as AnyTool,
    makeAddManyTool(db, getClientRoots) as unknown as AnyTool,
    makeListTool(db, getClientRoots) as unknown as AnyTool,
    makeGetTool(db, getClientRoots) as unknown as AnyTool,
    makeStatsTool(db, getClientRoots) as unknown as AnyTool,
    makeUpdateTool(db, getClientRoots) as unknown as AnyTool,
    makeLinkTool(db, getClientRoots) as unknown as AnyTool,
    makeUnlinkTool(db, getClientRoots) as unknown as AnyTool,
    makeSetParentTool(db, getClientRoots) as unknown as AnyTool,
    makeAppendToDescriptionTool(db, getClientRoots) as unknown as AnyTool,
    makeAddTagTool(db, getClientRoots) as unknown as AnyTool,
    makeRemoveTagTool(db, getClientRoots) as unknown as AnyTool,
    makeSearchTool(db, getClientRoots) as unknown as AnyTool,
    makeNextTool(db, getClientRoots) as unknown as AnyTool,
    makeRelatedTool(db, getClientRoots) as unknown as AnyTool,
    makeBlockersOfTool(db, getClientRoots) as unknown as AnyTool,
    makeChildrenOfTool(db, getClientRoots) as unknown as AnyTool,
    makeChangedSinceTool(db, getClientRoots) as unknown as AnyTool,
    makeValidateTool(db, getClientRoots) as unknown as AnyTool,
    makeImportJsonTool(db, getClientRoots) as unknown as AnyTool,
    makeExportTool(db, getClientRoots) as unknown as AnyTool,
  ];
  return new Map(tools.map((t) => [t.name, t]));
}

let shuttingDown = false;

async function shutdown(server: Server, db: Database.Database | null): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Failsafe: if server.close() hangs (e.g. dead transport on an orphaned process),
  // this unref'd timer guarantees exit within ~1 s regardless. unref() means the
  // timer itself never keeps an idle event loop alive — it only forces exit on a hang.
  // This also defeats the "guard set + hung close = immune to SIGTERM" wedge (defect #2).
  const failsafe = setTimeout(() => process.exit(0), 1000);
  failsafe.unref();
  logger.info("ticketgraph shutting down");
  try {
    db?.close();
  } catch (err) {
    logger.error("shutdown db close failed", { err: String(err) });
  }
  try {
    await server.close();
  } catch (err) {
    logger.error("shutdown close failed", { err: String(err) });
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const version = getPackageVersion();

  const { db, dbPath } = openDb();
  logger.info("db opened", { dbPath });

  const server = new Server(
    { name: "ticketgraph", version },
    { capabilities: { tools: {} } },
  );

  const getClientRoots = makeClientRootsProvider(server);
  const toolRegistry = makeToolRegistry({ db, dbPath, getClientRoots });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [...toolRegistry.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const tool = toolRegistry.get(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    logger.info("tool called", { name });
    const toolArgs = tool.parseArgs(request.params.arguments ?? {});
    const result = await tool.handle(toolArgs);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  });

  process.on("SIGTERM", () => void shutdown(server, db));
  process.on("SIGINT", () => void shutdown(server, db));

  logger.info("ticketgraph starting", { version, pid: process.pid });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Exit when the parent process closes the stdio pipe (defect #1 fix).
  // "end" fires on stdin EOF (parent exited cleanly); "close" covers fd close.
  // SIGHUP covers terminal/parent hangup. All route through shutdown() so the
  // db closes cleanly when possible. Using "end"/"close" events only — NOT a
  // "data" listener — so we never steal bytes from the StdioServerTransport.
  process.stdin.on("end", () => void shutdown(server, db));
  process.stdin.on("close", () => void shutdown(server, db));
  process.on("SIGHUP", () => void shutdown(server, db));
}

process.on("unhandledRejection", (err) => {
  logger.error("unhandledRejection", { err: String(err) });
});
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { err: String(err) });
});

main().catch((err) => {
  logger.error("fatal", { err: String(err) });
  process.exit(1);
});
