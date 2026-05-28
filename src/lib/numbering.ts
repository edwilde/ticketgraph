import type Database from "better-sqlite3";

const ID_PATTERN = /^([A-Z]+(?:-)?)?(\d+)$/;

/**
 * Infer the next ticket id for a project based on its existing ticket ids.
 *
 * Rules:
 * - Empty project → "T1"
 * - Single prefix (or only "" prefix) dominates (≥50% of rows or sole prefix) →
 *   return prefix + (max + 1)
 * - Multiple prefixes co-exist → throw, requiring explicit id
 */
export function inferNextId(db: Database.Database, projectId: string): string {
  const rows = db
    .prepare("SELECT id FROM tickets WHERE project_id = ?")
    .all(projectId) as Array<{ id: string }>;

  if (rows.length === 0) {
    return "T1";
  }

  // Parse each id; skip unparseable ones.
  const prefixMax = new Map<string, number>();

  for (const { id } of rows) {
    const match = ID_PATTERN.exec(id);
    if (!match) continue;
    const prefix = match[1] ?? "";
    const num = parseInt(match[2]!, 10);
    const current = prefixMax.get(prefix);
    if (current === undefined || num > current) {
      prefixMax.set(prefix, num);
    }
  }

  if (prefixMax.size === 0) {
    // No parseable ids — fall back to T1.
    return "T1";
  }

  if (prefixMax.size === 1) {
    const entry = [...prefixMax][0]!;
    return `${entry[0]}${entry[1] + 1}`;
  }

  // Multiple prefixes — check if one dominates (>50% of total rows).
  const total = rows.length;

  let dominantPrefix: string | null = null;
  let dominantMax = 0;

  for (const [prefix, max] of prefixMax) {
    const count = rows.filter((r) => {
      const m = ID_PATTERN.exec(r.id);
      return m !== null && (m[1] ?? "") === prefix;
    }).length;
    if (count / total > 0.5) {
      dominantPrefix = prefix;
      dominantMax = max;
      break;
    }
  }

  if (dominantPrefix !== null) {
    return `${dominantPrefix}${dominantMax + 1}`;
  }

  // No dominant prefix — collect all prefixes for the error message.
  const prefixes = [...prefixMap(rows)].join(", ");
  throw new Error(
    `Project '${projectId}' has multiple ID prefixes (${prefixes}). Pass id explicitly.`,
  );
}

function prefixMap(rows: Array<{ id: string }>): Set<string> {
  const s = new Set<string>();
  for (const { id } of rows) {
    const m = ID_PATTERN.exec(id);
    if (m) s.add(m[1] ?? "");
  }
  return s;
}
