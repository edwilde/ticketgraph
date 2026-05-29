/**
 * Shared contract for every MCP tool registered by the server.
 *
 * Each tool owns:
 *  - `name`            — the MCP tool name (dot-namespaced, e.g. `tickets.ping`)
 *  - `description`     — surfaced to clients in `tools/list`
 *  - `inputSchema`     — JSON Schema for the tool's arguments
 *  - `parseArgs(raw)`  — boundary validator that turns `unknown` (whatever
 *                        the MCP client sent) into the typed `TArgs` the
 *                        handler expects. Throw `McpError(InvalidParams, …)`
 *                        for shape problems. This is the only place tools
 *                        cast — `handle()` operates on validated input.
 *  - `handle(args)`    — pure business logic; returns `TResult` as plain
 *                        data. The server module wraps it into the MCP
 *                        `{ content: [...] }` envelope.
 */
export interface Tool<TArgs, TResult> {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    additionalProperties: boolean;
    required?: string[];
  };
  parseArgs(raw: unknown): TArgs;
  handle(args: TArgs): Promise<TResult>;
}

/** Heterogeneous registry entry — used by the server's tool dispatch. */
export type AnyTool = Tool<unknown, unknown>;
