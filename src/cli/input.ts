import type { Readable } from "node:stream";
import type { AnyTool } from "../tools/types.js";
import { parseFlags, bindPositionals, FlagParseError } from "./flags.js";

export interface ResolveRawArgsDeps {
  /** Stream read for `--json -`. Defaults to `process.stdin`. Injectable for tests. */
  stdin?: Readable;
}

const JSON_FLAG = "--json";
const JSON_FLAG_PREFIX = "--json=";

/** Collect a readable stream to a UTF-8 string. */
async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Detect whether `tokens` begins with a `--json` hatch in either form and
 * return the value string, or `null` if the hatch is not present.
 *
 * Accepted forms (both are exclusive — no other tokens may be present):
 *   `--json <value>`     → tokens.length === 2
 *   `--json=<value>`     → tokens.length === 1
 */
function detectJsonHatch(tokens: string[]): string | null {
  // Space form: `--json <value>` — first token is the bare flag.
  if (tokens[0] === JSON_FLAG) {
    return tokens[1] ?? null; // null → missing-value FlagParseError below
  }
  // Equals form: `--json=<value>` — single token, value after the `=`.
  if (tokens[0]?.startsWith(JSON_FLAG_PREFIX)) {
    return tokens[0].slice(JSON_FLAG_PREFIX.length);
  }
  return null;
}

/**
 * Turn CLI tokens into the raw args object that `tool.parseArgs` expects.
 *
 * Two modes:
 *  - `--json <string>` / `--json=<string>` / `--json -` / `--json=-` (stdin)
 *    — the content is used VERBATIM as the full args object and bypasses flag
 *    parsing. This is the ONLY way to drive structured-input commands like
 *    `add_many`. Both space and `=` forms are supported; `--json` must be the
 *    sole input (no other flags or positionals).
 *  - otherwise — schema-driven flag parsing plus single-positional binding.
 */
export async function resolveRawArgs(
  tool: AnyTool,
  cliName: string,
  tokens: string[],
  deps: ResolveRawArgsDeps = {},
): Promise<Record<string, unknown>> {
  const jsonValue = detectJsonHatch(tokens);
  const isJsonHatch = jsonValue !== null || tokens[0] === JSON_FLAG;

  if (isJsonHatch) {
    if (jsonValue === null) {
      // `--json` with no following value (space form only, tokens.length === 1).
      throw new FlagParseError(`${JSON_FLAG} requires a value (JSON string or '-')`);
    }
    // Exclusivity: the hatch must be the only input.
    const expectedLength = tokens[0] === JSON_FLAG ? 2 : 1;
    if (tokens.length !== expectedLength) {
      throw new FlagParseError(
        `${JSON_FLAG} cannot be combined with other flags or positionals`,
      );
    }

    const text = jsonValue === "-" ? await readStream(deps.stdin ?? process.stdin) : jsonValue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new FlagParseError(
        `invalid JSON for ${JSON_FLAG}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new FlagParseError(
        `${JSON_FLAG} content must be a JSON object (the full args), not an array or scalar`,
      );
    }
    return parsed as Record<string, unknown>;
  }

  // add_many is the only structured-input command: flags cannot express its
  // arrays-of-objects shape, so route the author to --json explicitly rather
  // than surfacing a confusing parseArgs error.
  if (cliName === "add_many" && tokens.length > 0) {
    throw new FlagParseError(
      `add_many requires --json '{"tickets":[…]}' or --json -`,
    );
  }

  const { values, positionals } = parseFlags(tool.inputSchema, tokens);
  return bindPositionals(cliName, positionals, values);
}
