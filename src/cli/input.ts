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
 * The `--json` hatch pulled out of a token list, plus the tokens left over for
 * ordinary flag parsing. `value` is null when no hatch is present.
 */
interface JsonHatch {
  value: string | null;
  rest: string[];
}

/**
 * Split `tokens` into the `--json` hatch value and the remaining tokens.
 *
 * The hatch is recognised at ANY position, in either form:
 *   `--json <value>`     the value token is consumed too
 *   `--json=<value>`     a single token
 *
 * Throws when the flag appears twice, or when the space form has no value (end
 * of tokens, or the next token is itself a flag).
 */
function extractJsonHatch(tokens: string[]): JsonHatch {
  let value: string | null = null;
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const isSpaceForm = token === JSON_FLAG;
    const isEqualsForm = token.startsWith(JSON_FLAG_PREFIX);
    if (!isSpaceForm && !isEqualsForm) {
      rest.push(token);
      continue;
    }
    if (value !== null) {
      throw new FlagParseError(`${JSON_FLAG} given more than once`);
    }
    if (isEqualsForm) {
      value = token.slice(JSON_FLAG_PREFIX.length);
      continue;
    }
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new FlagParseError(`${JSON_FLAG} requires a value (JSON string or '-')`);
    }
    value = next;
    i++;
  }

  return { value, rest };
}

/** Parse a `--json` payload into the args object it has to be. */
function parseJsonPayload(text: string): Record<string, unknown> {
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

/**
 * Turn CLI tokens into the raw args object that `tool.parseArgs` expects.
 *
 * Two input channels, usable together:
 *  - `--json <string>` / `--json=<string>` / `--json -` / `--json=-` (stdin):
 *    the content is an args object, used verbatim. This is the ONLY way to
 *    express structured input such as `add_many`'s arrays of objects.
 *  - ordinary flags plus a single positional: schema-driven parsing.
 *
 * When both are present the two are merged, so `--project p --json '{"tickets":
 * [...]}'` selects the project the same way every other command's `--project`
 * does. A key supplied through BOTH channels is a usage error rather than a
 * silent last-wins.
 */
export async function resolveRawArgs(
  tool: AnyTool,
  cliName: string,
  tokens: string[],
  deps: ResolveRawArgsDeps = {},
): Promise<Record<string, unknown>> {
  const { value: jsonValue, rest } = extractJsonHatch(tokens);

  // add_many is the only structured-input command: flags cannot express its
  // arrays-of-objects shape, so route the author to --json explicitly rather
  // than surfacing a confusing parseArgs error.
  if (jsonValue === null && cliName === "add_many" && tokens.length > 0) {
    throw new FlagParseError(`add_many requires --json '{"tickets":[...]}' or --json -`);
  }

  const { values, positionals } = parseFlags(tool.inputSchema, rest);
  const flagArgs = bindPositionals(cliName, positionals, values);

  if (jsonValue === null) return flagArgs;

  const text = jsonValue === "-" ? await readStream(deps.stdin ?? process.stdin) : jsonValue;
  const jsonArgs = parseJsonPayload(text);

  for (const key of Object.keys(flagArgs)) {
    if (key in jsonArgs) {
      throw new FlagParseError(
        `--${key} is also set inside ${JSON_FLAG}; give it once, not through both`,
      );
    }
  }

  return { ...jsonArgs, ...flagArgs };
}
