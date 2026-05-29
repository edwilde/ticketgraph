/**
 * Centralised timestamp generator.
 * Returns UTC ISO 8601 with millisecond precision: "YYYY-MM-DDTHH:MM:SS.sssZ".
 * Equivalent to SQLite's strftime('%Y-%m-%dT%H:%M:%fZ', 'now').
 */
export function nowIso(): string {
  return new Date().toISOString();
}
