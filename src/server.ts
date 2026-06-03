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
import { makeClientRootsProvider } from "./lib/roots.js";
import { makeToolRegistry } from "./registry.js";
import { runCli } from "./cli/index.js";

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

// Dual-mode entry. No-args, a leading `--mcp`, or a leading `mcp` boots the MCP
// stdio server (the path MCP clients launch over stdio — must NOT change). Anything else is
// a CLI invocation: runCli returns an exit code and never touches the T18
// shutdown handlers, so the process exits naturally instead of waiting on stdin.
const argv = process.argv.slice(2);
const serverMode = argv.length === 0 || argv[0] === "--mcp" || argv[0] === "mcp";

if (serverMode) {
  main().catch((err) => {
    logger.error("fatal", { err: String(err) });
    process.exit(1);
  });
} else {
  runCli(argv)
    .then((code) => process.exit(code))
    .catch((err) => {
      logger.error("cli fatal", { err: String(err) });
      process.exit(1);
    });
}
