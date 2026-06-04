import type { AnyTool } from "../tools/types.js";

/** Minimal view of a JSON-Schema property the flag parser needs. */
interface PropSchema {
  type?: string;
  oneOf?: Array<{ type?: string }>;
}

/** Structural (not value-level) parse error — the caller maps this to exit 2. */
export class FlagParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagParseError";
  }
}

export interface ParsedFlags {
  values: Record<string, unknown>;
  positionals: string[];
}

/**
 * Commands that accept a single bare positional, mapped to the param it binds.
 * Narrowed to the verified single-required-id commands only. Commands with a
 * second required field (set_parent, add_tag, …) are deliberately absent — they
 * take explicit flags so the binding stays unambiguous.
 */
export const PRIMARY_POSITIONAL: Record<string, string> = {
  get: "id",
  related: "id",
  blockers_of: "id",
  children_of: "id",
};

/**
 * Fold parsed positionals into the values object for a command. Mutates and
 * returns `values`. Throws {@link FlagParseError} (→ exit 2) when the command
 * takes no positional or more than one is supplied.
 */
export function bindPositionals(
  cliName: string,
  positionals: string[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  if (positionals.length === 0) return values;

  const param = PRIMARY_POSITIONAL[cliName];
  if (param === undefined) {
    throw new FlagParseError(
      `${cliName} takes no positional argument; use --flags`,
    );
  }
  if (positionals.length > 1) {
    throw new FlagParseError(
      `${cliName} takes at most one positional argument (got ${positionals.length})`,
    );
  }
  values[param] = positionals[0];
  return values;
}

/** Does this property accept (or always produce) an array? */
function isArrayProp(prop: PropSchema): boolean {
  return prop.type === "array";
}

/** Does this oneOf property have an array branch (e.g. status: string | string[])? */
function hasArrayBranch(prop: PropSchema): boolean {
  return Array.isArray(prop.oneOf) && prop.oneOf.some((b) => b.type === "array");
}

/**
 * Coerce CLI tokens into a raw args object using the tool's JSON Schema for
 * type-driven coercion. Does NOT validate values (enums/ranges/required stay
 * in `tool.parseArgs`); only structural errors are raised here.
 *
 * Coercion rules (type-driven):
 *  - number prop   → `Number(value)` (NaN passes through to parseArgs)
 *  - boolean prop  → presence ⇒ `true`, consumes NO value
 *  - array prop    → always an array; consumes the RUN of following non-`--`
 *                    tokens (`--ids T1 T2 T3` ⇒ ["T1","T2","T3"]), and
 *                    repeated flags still accumulate (`--ids a --ids b`)
 *  - oneOf+array   → single use ⇒ scalar, repeated ⇒ array
 *  - otherwise     → string
 *
 * Supports both `--key value` and `--key=value`. A value starting with `--`
 * is only reachable via the `=` form (the space form treats `--…` as a flag).
 */
export function parseFlags(
  schema: AnyTool["inputSchema"],
  tokens: string[],
): ParsedFlags {
  const properties = schema.properties;
  const values: Record<string, unknown> = {};
  const positionals: string[] = [];
  // Track which keys have been seen >1 time so oneOf+array can switch scalar→array.
  const seenCount = new Map<string, number>();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    const key = eq >= 0 ? body.slice(0, eq) : body;
    const inlineValue = eq >= 0 ? body.slice(eq + 1) : undefined;

    if (!(key in properties)) {
      throw new FlagParseError(`unknown flag: --${key}`);
    }
    const prop = properties[key] as PropSchema;

    // Boolean flags are presence-only and never consume a value.
    if (prop.type === "boolean") {
      values[key] = true;
      continue;
    }

    // Resolve the raw string value: inline `=value`, else the next token.
    let rawValue: string;
    if (inlineValue !== undefined) {
      rawValue = inlineValue;
    } else {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new FlagParseError(`flag --${key} requires a value`);
      }
      rawValue = next;
      i++;
    }

    const count = (seenCount.get(key) ?? 0) + 1;
    seenCount.set(key, count);

    if (prop.type === "number") {
      values[key] = Number(rawValue);
    } else if (isArrayProp(prop)) {
      const arr = (values[key] as string[] | undefined) ?? [];
      arr.push(rawValue);
      // Greedily consume the run of following non-`--` tokens so
      // `--ids T1 T2 T3` yields ["T1","T2","T3"]. The run stops at the next
      // `--flag` (or end of tokens); repeated `--ids a --ids b` still
      // accumulates because each occurrence appends to the same array.
      while (i + 1 < tokens.length && !tokens[i + 1]!.startsWith("--")) {
        arr.push(tokens[i + 1]!);
        i++;
      }
      values[key] = arr;
    } else if (hasArrayBranch(prop)) {
      if (count === 1) {
        values[key] = rawValue;
      } else if (count === 2) {
        values[key] = [values[key] as string, rawValue];
      } else {
        (values[key] as string[]).push(rawValue);
      }
    } else {
      values[key] = rawValue;
    }
  }

  return { values, positionals };
}
