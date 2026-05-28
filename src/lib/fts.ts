/**
 * FTS5 query sanitiser.
 *
 * Converts arbitrary user input into a safe FTS5 MATCH expression by
 * quoting every whitespace-delimited token. This neutralises all FTS5
 * operator syntax (`:`, `(`, `*`, `-`, `OR`, `NEAR`) so arbitrary English
 * never causes a `fts5: syntax error`. Porter stemming still applies to
 * quoted single terms, so "estimators" still matches "estimator".
 *
 * Returns an empty string for empty / whitespace-only input.
 * Callers must check for empty and throw InvalidParams.
 */
export function sanitiseFtsQuery(q: string): string {
  const trimmed = q.trim();
  if (!trimmed) return "";

  const tokens = trimmed.split(/\s+/);
  return tokens
    .map((tok) => {
      // Double any embedded double-quotes so they are valid inside a quoted FTS5 term.
      const escaped = tok.replace(/"/g, '""');
      return `"${escaped}"`;
    })
    .join(" ");
}
