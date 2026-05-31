// When quiet, info() is silenced (e.g. on the CLI path, where the MCP server's
// startup chatter would pollute stderr). error() is NEVER gated. Off by default
// so the MCP server path keeps its full logging.
let quiet = false;

export function setQuiet(v: boolean): void {
  quiet = v;
}

export function info(msg: string, meta?: Record<string, unknown>): void {
  if (quiet) return;
  const line =
    meta !== undefined
      ? `${new Date().toISOString()} INFO ${msg} ${JSON.stringify(meta)}`
      : `${new Date().toISOString()} INFO ${msg}`;
  process.stderr.write(line + "\n");
}

export function error(msg: string, meta?: Record<string, unknown>): void {
  const line =
    meta !== undefined
      ? `${new Date().toISOString()} ERROR ${msg} ${JSON.stringify(meta)}`
      : `${new Date().toISOString()} ERROR ${msg}`;
  process.stderr.write(line + "\n");
}
