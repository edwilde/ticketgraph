import type Database from "better-sqlite3";

const ID_PATTERN = /^([A-Z]+(?:-)?)?(\d+)$/;

/**
 * Derive the (prefix, max) base for a project's next-id numbering from a
 * single DB scan, applying the shared prefix-selection rules:
 * - Empty / no parseable ids → prefix "T", max 0 (so the first id is "T1").
 * - Single prefix → that prefix and its max number.
 * - Multiple prefixes with one >50%-dominant → the dominant prefix and its max.
 * - Multiple prefixes with no dominant → throw, requiring an explicit id.
 *
 * Both inferNextId and inferNextIds use this so they agree on prefix selection.
 */
function deriveBase(
  db: Database.Database,
  projectId: string,
): { prefix: string; max: number } {
  const rows = db
    .prepare("SELECT id FROM tickets WHERE project_id = ?")
    .all(projectId) as Array<{ id: string }>;

  if (rows.length === 0) {
    return { prefix: "T", max: 0 };
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
    return { prefix: "T", max: 0 };
  }

  if (prefixMax.size === 1) {
    const entry = [...prefixMax][0]!;
    return { prefix: entry[0], max: entry[1] };
  }

  // Multiple prefixes — check if one dominates (>50% of total rows).
  const total = rows.length;

  for (const [prefix, max] of prefixMax) {
    const count = rows.filter((r) => {
      const m = ID_PATTERN.exec(r.id);
      return m !== null && (m[1] ?? "") === prefix;
    }).length;
    if (count / total > 0.5) {
      return { prefix, max };
    }
  }

  // No dominant prefix — collect all prefixes for the error message.
  const prefixes = [...prefixMap(rows)].join(", ");
  throw new Error(
    `Project '${projectId}' has multiple ID prefixes (${prefixes}). Pass id explicitly.`,
  );
}

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
  const { prefix, max } = deriveBase(db, projectId);
  return `${prefix}${max + 1}`;
}

/**
 * Infer `count` sequential next ticket ids for a project, suitable for a batch
 * create where several tickets omit their id.
 *
 * Uses the SAME prefix/number rules as inferNextId (via the shared base
 * derivation), then runs this skip loop:
 *
 *   let n = max; const out = [];
 *   while (out.length < count) { n++; const id = prefix + n;
 *                                if (!reserved.has(id)) out.push(id); }
 *
 * The counter keeps advancing, emitting only ids NOT in `reserved`, until
 * exactly `count` non-reserved ids have been collected. `count` is the number
 * EMITTED — reserved skips do not consume it — so non-contiguous reserved sets
 * are handled correctly. `count === 0` returns [] without scanning the DB, so
 * an empty batch never throws on a multi-prefix project.
 */
export function inferNextIds(
  db: Database.Database,
  projectId: string,
  count: number,
  reserved: Set<string>,
): string[] {
  if (count === 0) {
    return [];
  }

  const { prefix, max } = deriveBase(db, projectId);

  let n = max;
  const out: string[] = [];
  while (out.length < count) {
    n++;
    const id = prefix + n;
    if (!reserved.has(id)) out.push(id);
  }
  return out;
}

function prefixMap(rows: Array<{ id: string }>): Set<string> {
  const s = new Set<string>();
  for (const { id } of rows) {
    const m = ID_PATTERN.exec(id);
    if (m) s.add(m[1] ?? "");
  }
  return s;
}
