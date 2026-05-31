import Database from "better-sqlite3";
import { openDb } from "../db.js";
import { makeToolRegistry } from "../registry.js";
import { NO_ROOTS } from "../lib/roots.js";
import { getPackageVersion } from "../version.js";
import * as logger from "../logger.js";
import { buildCatalogue, buildHelpText, buildCommandHelp } from "./commands.js";
import { dispatch } from "./dispatch.js";
import { type Format, FORMATS, isFormat } from "./format.js";

const FORMAT_USAGE = `usage: --format <${FORMATS.join("|")}> (or TICKETGRAPH_FORMAT env)`;

/**
 * Outcome of extracting the value-bearing global `--format` flag from argv.
 * `argv` is the argv with the flag (and, for the space form, its value token)
 * stripped. A null `format` with `error` set means a structural fault (bad
 * value or bare trailing `--format`) the caller maps to exit 2.
 */
interface FormatExtraction {
  argv: string[];
  format: Format | null;
  error: string | null;
}

/**
 * Pull the global `--format` flag out of argv BEFORE command/flag parsing, the
 * same way `--verbose` is stripped — except `--format` consumes a value too.
 * Supports `--format=<val>` (inline) and `--format <val>` (space, the value
 * token is also removed). A bare trailing `--format` with no value is an error.
 *
 * Resolution precedence: a present flag wins; otherwise TICKETGRAPH_FORMAT env;
 * otherwise the caller's default ("compact"). An invalid flag OR env value is a
 * structural error (exit 2). No TTY auto-detection.
 */
function extractFormat(argv: string[]): FormatExtraction {
  const rest: string[] = [];
  let flagValue: string | undefined;
  let error: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--format") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        error = FORMAT_USAGE;
      } else {
        flagValue = next;
        i++; // consume the value token too
      }
      continue;
    }
    if (tok.startsWith("--format=")) {
      flagValue = tok.slice("--format=".length);
      continue;
    }
    rest.push(tok);
  }

  if (error !== null) return { argv: rest, format: null, error };

  const candidate = flagValue ?? process.env["TICKETGRAPH_FORMAT"];
  if (candidate === undefined) {
    return { argv: rest, format: "compact", error: null };
  }
  if (!isFormat(candidate)) {
    return { argv: rest, format: null, error: FORMAT_USAGE };
  }
  return { argv: rest, format: candidate, error: null };
}

/**
 * Run the ticketgraph CLI. Resolves the first positional as a command,
 * opens the database in write mode, builds the tool catalogue, and dispatches.
 *
 * Returns an exit code — it NEVER calls `process.exit` (so it stays testable
 * and composable). Exit-code contract:
 *   0 — success
 *   2 — usage/input error (unknown command, unknown flag, bad invocation, tool McpError)
 *   1 — runtime error (tool threw a non-McpError) OR environment error (openDb failed)
 *
 * Stdout carries results only; stderr carries diagnostics only.
 *
 * Project resolution is unchanged: subdirectories resolve via root_path
 * prefix-matching in resolveProjectForDir, and the CLI passes NO_ROOTS so an
 * MCP client's roots never leak in. Explicit `--project <id>` / `--project all`
 * flow through requireProject as before. No git-root walk-up is needed.
 */
export async function runCli(argv: string[]): Promise<number> {
  // --verbose is a global flag like --help: recognised ANYWHERE and STRIPPED
  // before any command/flag parsing, so it never reaches a tool's flag parser.
  // CLI runs are quiet by default — info() chatter (e.g. the "migrations: applied"
  // line) would pollute the diagnostics-only stderr stream. --verbose or
  // TICKETGRAPH_DEBUG opts back into full logging. error() is never gated.
  // The MCP server path (main()/server.ts) deliberately does NOT call setQuiet —
  // its stderr logging stays on.
  const verbose = argv.includes("--verbose");
  logger.setQuiet(!(verbose || process.env["TICKETGRAPH_DEBUG"]));
  argv = argv.filter((a) => a !== "--verbose");

  // --version short-circuits BEFORE everything else (it is terminal and wins
  // over --help and any --format error): no DB, no format strip.
  if (argv.includes("--version")) {
    process.stdout.write(`${getPackageVersion()}\n`);
    return 0;
  }

  // --format is a value-bearing global flag (like --verbose, but it consumes a
  // value): recognised anywhere, resolved (flag › TICKETGRAPH_FORMAT › compact),
  // and stripped — flag AND, for the space form, its value token. It is stripped
  // FIRST so the --help branch below can read the real command from cleanArgv
  // (without this, `--format json list --help` would mistake `json` for the
  // command). The format *error* is deferred until after --help so an explicit
  // help request always wins. No TTY auto-detection.
  const fmt = extractFormat(argv);
  const cleanArgv = fmt.argv;

  // --help short-circuits BEFORE the real DB opens and BEFORE the format error /
  // unknown-command / -prefixed-arg → 2 paths. The command is the first token in
  // cleanArgv NOT starting with `-`; a KNOWN command renders per-command help,
  // anything else (unknown command, no command) falls back to top-level help. A
  // throwaway :memory: handle gives tool factories a real (type-honest) db
  // reference in case any ever touches db at construction in future.
  if (cleanArgv.includes("--help")) {
    const command = cleanArgv.find((a) => !a.startsWith("-"));
    const metaDb = new Database(":memory:");
    let helpText: string;
    try {
      const registry = makeToolRegistry({ db: metaDb, dbPath: "", getClientRoots: NO_ROOTS });
      const tool = command === undefined ? undefined : buildCatalogue(registry).get(command);
      helpText = tool === undefined ? buildHelpText(registry) : buildCommandHelp(tool);
    } finally {
      metaDb.close();
    }
    process.stdout.write(helpText);
    return 0;
  }

  // No --help: NOW surface a deferred --format fault. An invalid value (flag or
  // env) or a bare trailing --format is a usage error → exit 2.
  if (fmt.error !== null || fmt.format === null) {
    process.stderr.write((fmt.error ?? FORMAT_USAGE) + "\n");
    return 2;
  }
  argv = cleanArgv;
  const format = fmt.format;

  const cliName = argv[0];

  if (cliName === undefined || cliName.startsWith("-")) {
    process.stderr.write("usage: ticketgraph <command> [--flags]\n");
    return 2;
  }

  // openDb is INSIDE the try so a stale-DB integrity guard or SQLITE_BUSY can't
  // escape runCli as an unhandled rejection. An open failure is an environment
  // error (not usage): emit the one-line message (no stack) and return 1. The
  // finally closes only an assigned handle, so a throw before assignment can't
  // double-close, and the success path closes exactly once.
  let db: Database.Database | undefined;
  let dbPath: string;
  try {
    ({ db, dbPath } = openDb());

    const registry = makeToolRegistry({ db, dbPath, getClientRoots: NO_ROOTS });
    const catalogue = buildCatalogue(registry);
    const tool = catalogue.get(cliName);

    if (tool === undefined) {
      process.stderr.write(
        `unknown command: ${cliName}\nusage: ticketgraph <command> [--flags]\n`,
      );
      return 2;
    }

    const result = await dispatch(tool, cliName, argv.slice(1), { format });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.code;
  } catch (err) {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    return 1;
  } finally {
    db?.close();
  }
}
