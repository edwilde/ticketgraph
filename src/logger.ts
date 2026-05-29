export function info(msg: string, meta?: Record<string, unknown>): void {
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
