import type { Readable } from "node:stream";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AnyTool } from "../tools/types.js";
import { resolveRawArgs } from "./input.js";
import { FlagParseError } from "./flags.js";
import { type Format, formatResult } from "./format.js";

/**
 * Outcome of dispatching a resolved CLI command.
 * `stdout`/`stderr` carry the text the caller should emit; `code` is the
 * process exit code. Keeping I/O out of dispatch makes it unit-testable
 * without spawning a process or capturing the global streams — `runCli`
 * performs the actual `process.stdout.write` and owns the DB lifecycle.
 */
export interface DispatchResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface DispatchDeps {
  /** Stream read for `--json -`. Defaults to `process.stdin`. Injectable for tests. */
  stdin?: Readable;
  /** Output format for the success path. Defaults to "compact" (the T24 default). */
  format?: Format;
}

/**
 * Run a resolved CLI command end-to-end:
 *   tokens → resolveRawArgs → tool.parseArgs → tool.handle → formatResult.
 *
 * Output format is `deps.format` (default "compact"); "json" reproduces the
 * pre-T24 byte-identical single-line `JSON.stringify(result)`.
 *
 * Exit-code contract:
 *   0 — success (formatted result on stdout)
 *   2 — usage/input error on stderr: structural invocation faults (unknown/missing
 *       flag, bad --json) AND any tool McpError (every tool McpError is usage-class —
 *       it's only ever thrown for input/usage faults, always InvalidParams)
 *   1 — runtime error (parseArgs/handle threw a non-McpError) on stderr
 *
 * Errors emit only `err.message` (no stack). stdout carries results only.
 */
export async function dispatch(
  tool: AnyTool,
  cliName: string,
  tokens: string[],
  deps: DispatchDeps = {},
): Promise<DispatchResult> {
  let raw: Record<string, unknown>;
  try {
    raw = await resolveRawArgs(tool, cliName, tokens, { stdin: deps.stdin });
  } catch (err) {
    if (err instanceof FlagParseError) {
      return { stdout: "", stderr: err.message + "\n", code: 2 };
    }
    return { stdout: "", stderr: messageOf(err) + "\n", code: 1 };
  }

  try {
    const args = tool.parseArgs(raw);
    const result = await tool.handle(args);
    const fmt: Format = deps.format ?? "compact";
    return { stdout: formatResult(cliName, result, fmt) + "\n", stderr: "", code: 0 };
  } catch (err) {
    // Every tool McpError is usage-class (always InvalidParams) → exit 2. Any
    // other throw is an unexpected runtime fault → exit 1. Match on the type, not
    // the error code number.
    const code = err instanceof McpError ? 2 : 1;
    return { stdout: "", stderr: messageOf(err) + "\n", code };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
