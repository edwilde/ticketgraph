import type { AnyTool } from "../tools/types.js";
import { PRIMARY_POSITIONAL } from "./flags.js";
import { FORMATS } from "./format.js";

const TOOL_PREFIX = "tickets.";

/**
 * Map an MCP tool name to its CLI command name: strip the `tickets.` prefix,
 * preserving underscores (`tickets.add_many` → `add_many`).
 */
export function cliNameFor(toolName: string): string {
  return toolName.startsWith(TOOL_PREFIX)
    ? toolName.slice(TOOL_PREFIX.length)
    : toolName;
}

/** Inverse of {@link cliNameFor}: prepend the `tickets.` prefix. */
export function toolNameFor(cliName: string): string {
  return TOOL_PREFIX + cliName;
}

/**
 * Build a lookup from CLI command name → tool, given the populated registry.
 */
export function buildCatalogue(
  registry: Map<string, AnyTool>,
): Map<string, AnyTool> {
  const catalogue = new Map<string, AnyTool>();
  for (const tool of registry.values()) {
    catalogue.set(cliNameFor(tool.name), tool);
  }
  return catalogue;
}

/**
 * Render top-level help, derived from the registry: one line per command
 * (`<command> — <description>`), a `global flags:` section documenting the
 * flags every command shares, a pointer to per-command help, and a note that
 * `--mcp`/no-args runs the MCP server. The command list stays registry-derived;
 * per-command detail lives in {@link buildCommandHelp} (`<command> --help`).
 */
export function buildHelpText(registry: Map<string, AnyTool>): string {
  const catalogue = buildCatalogue(registry);
  const lines = ["usage: ticketgraph <command> [--flags]", "", "commands:"];
  for (const [name, tool] of catalogue) {
    const desc =
      tool.description.length > 80
        ? tool.description.slice(0, 79) + "…"
        : tool.description;
    lines.push(`  ${name} — ${desc}`);
  }
  lines.push("");
  lines.push("global flags:");
  lines.push(
    `  --format <${FORMATS.join("|")}>  output format (default compact; or TICKETGRAPH_FORMAT)`,
  );
  lines.push("  --project <id>  project id, or 'all'; omit to resolve from cwd");
  lines.push(
    "  --json '<obj>' / --json -  structured input as JSON (stdin with '-'); required for add_many",
  );
  lines.push("  --verbose  enable INFO logging (or TICKETGRAPH_DEBUG)");
  lines.push("  --version  print the version and exit");
  lines.push("  --help  show this help; <command> --help shows per-command detail");
  lines.push("");
  lines.push("Run with --mcp or no arguments to start the MCP server.");
  return lines.join("\n") + "\n";
}

/** Minimal view of a JSON-Schema property the help renderer introspects. */
interface PropSchema {
  type?: string;
  enum?: unknown[];
  description?: string;
  nullable?: boolean;
  oneOf?: Array<{ type?: string }>;
  items?: { type?: string };
}

/**
 * Is this property expressible as a CLI flag? Mirrors the runtime contract in
 * flags.ts/input.ts: string/number/boolean and arrays-of-scalars are flags;
 * an OBJECT or an ARRAY-OF-OBJECTS (e.g. add_many.tickets) is NOT — it can only
 * be supplied via `--json`. A `oneOf` is flag-expressible iff every branch is.
 * A typeless property degrades to a bare flag (the parser treats it as a string).
 */
function isFlagExpressible(prop: PropSchema): boolean {
  if (prop.type === "object") return false;
  if (prop.type === "array") {
    return prop.items === undefined || prop.items.type !== "object";
  }
  if (Array.isArray(prop.oneOf)) {
    return prop.oneOf.every((b) => b.type !== "object");
  }
  return true;
}

/** The scalar type a property advertises for the `--name <type>` hint. */
function flagType(prop: PropSchema): string | undefined {
  if (prop.type === "array") {
    const itemType = prop.items?.type;
    return itemType !== undefined ? `${itemType}[]` : "array";
  }
  if (typeof prop.type === "string") return prop.type;
  if (Array.isArray(prop.oneOf)) {
    const branch = prop.oneOf.find((b) => typeof b.type === "string");
    return branch?.type;
  }
  return undefined;
}

/**
 * Render per-command help for one tool from its `inputSchema` (`<command> --help`).
 * Header is `usage: ticketgraph <cliName> [--flags]` plus the tool description.
 *
 * Each flag-expressible property renders a `--<name> <type>` line, annotated
 * with `(required)`, `one of: a|b|c` (from `enum`), and the property's
 * `description`. Booleans render as `--<name> (flag)`; a typeless property as a
 * bare `--<name>` line. OBJECT / ARRAY-OF-OBJECT properties are NOT flags — they
 * are listed under a `structured input:` note pointing at `--json` (matching the
 * runtime, which rejects e.g. a `--tickets` flag). For a PRIMARY_POSITIONAL
 * command, a positional hint is appended.
 */
export function buildCommandHelp(tool: AnyTool): string {
  const cliName = cliNameFor(tool.name);
  const lines = [`usage: ticketgraph ${cliName} [--flags]`, "", tool.description, ""];

  const properties = tool.inputSchema.properties;
  const required = new Set(tool.inputSchema.required ?? []);
  const structured: string[] = [];

  const flagLines: string[] = [];
  for (const name of Object.keys(properties)) {
    const prop = properties[name] as PropSchema;

    if (!isFlagExpressible(prop)) {
      structured.push(name);
      continue;
    }

    let line: string;
    if (prop.type === "boolean") {
      line = `  --${name} (flag)`;
    } else {
      const type = flagType(prop);
      line = type === undefined ? `  --${name}` : `  --${name} ${type}`;
    }
    if (required.has(name)) line += " (required)";
    if (Array.isArray(prop.enum)) line += ` — one of: ${prop.enum.join("|")}`;
    if (typeof prop.description === "string") {
      line += `${Array.isArray(prop.enum) ? ";" : " —"} ${prop.description}`;
    }
    if (prop.nullable === true && prop.type === "string") {
      line += " (to clear/set null, use --json)";
    }
    flagLines.push(line);
  }

  if (flagLines.length > 0) {
    lines.push("flags:");
    lines.push(...flagLines);
  }

  if (structured.length > 0) {
    lines.push("");
    lines.push("structured input:");
    lines.push(
      `  ${structured.join(", ")} cannot be passed as flags; supply the full args object via --json '<obj>' or --json - (stdin).`,
    );
  }

  if (cliName in PRIMARY_POSITIONAL) {
    lines.push("");
    lines.push(`<id> may be given as a positional (e.g. ticketgraph ${cliName} T22).`);
  }

  return lines.join("\n") + "\n";
}
