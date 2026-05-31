/**
 * Output formatting for CLI results. PURE: string in, string out, no I/O.
 *
 * Three formats, selected upstream in runCli (flag › env › default):
 *   compact (DEFAULT) — aligned-ish text, one line per row, no repeated JSON
 *                       keys. The token win: drops the per-row `{"id":…}` noise.
 *   json              — JSON.stringify(result): byte-identical to the pre-T24
 *                       default single-line output. Lossless.
 *   table             — same rows + a header row + per-column width alignment.
 *
 * The renderer is GENERIC. It inspects result shape (a row-collection, a
 * count-map like stats, or a flat/grouped object) rather than branching on the
 * cliName, so new tools render without per-tool code.
 */

export type Format = "compact" | "json" | "table";

/** The valid format names, in the order shown in the usage message. */
export const FORMATS: readonly Format[] = ["compact", "json", "table"];

/** True when `value` is one of the three valid format names. */
export function isFormat(value: string): value is Format {
  return (FORMATS as readonly string[]).includes(value);
}

/** Title truncation width for ticket rows (display-only — json stays lossless). */
const TITLE_MAX = 60;

/** Ticket-row columns, in display order. */
const TICKET_COLUMNS = [
  "id",
  "status",
  "priority",
  "type",
  "effort",
  "title",
] as const;

/** Keys that, when present and array-valued, are the result's row collection. */
const ROW_KEYS = [
  "rows",
  "hits",
  "changes",
  "children",
  "blockers",
  "tickets",
] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The first present row collection: the first array-valued key in ROW_KEYS, or
 * a single `{ticket}` wrapped as `[ticket]`. Returns null when the result has no
 * recognisable rows (a flat object or a count-map).
 */
export function rowsOf(result: unknown): Record<string, unknown>[] | null {
  if (!isObject(result)) return null;
  for (const key of ROW_KEYS) {
    const val = result[key];
    if (Array.isArray(val)) {
      return val.filter(isObject) as Record<string, unknown>[];
    }
  }
  const ticket = result["ticket"];
  if (isObject(ticket)) return [ticket];
  return null;
}

/** Does this row look like a ticket row (has the full ticket column set)? */
function isTicketRow(row: Record<string, unknown>): boolean {
  return TICKET_COLUMNS.every((c) => c in row);
}

/** Render a single scalar cell value for text output. null/undefined → "-". */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  return String(value);
}

/**
 * Column values for one row. Ticket rows use the fixed TICKET_COLUMNS (with
 * title truncated); other rows fall back to their own scalar keys in insertion
 * order. Arrays/objects on a non-ticket row are JSON-encoded so a row never
 * silently drops a field.
 */
function rowCells(row: Record<string, unknown>): string[] {
  if (isTicketRow(row)) {
    return TICKET_COLUMNS.map((col) => {
      const raw = cell(row[col]);
      return col === "title" && raw.length > TITLE_MAX
        ? raw.slice(0, TITLE_MAX - 1) + "…"
        : raw;
    });
  }
  return Object.keys(row).map((k) => {
    const v = row[k];
    return isObject(v) || Array.isArray(v) ? JSON.stringify(v) : cell(v);
  });
}

/** Header labels for a row collection (ticket columns or the first row's keys). */
function headerFor(rows: Record<string, unknown>[]): string[] {
  if (rows.length === 0) return [...TICKET_COLUMNS];
  const first = rows[0]!;
  return isTicketRow(first) ? [...TICKET_COLUMNS] : Object.keys(first);
}

/** Per-column widths = max cell width across all matrix rows. */
function columnWidths(matrix: string[][]): number[] {
  const widths: number[] = [];
  for (const row of matrix) {
    row.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.length);
    });
  }
  return widths;
}

/** Pad each cell to its column width (last column unpadded) and space-join. */
function alignRow(cells: string[], widths: number[]): string {
  return cells
    .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!)))
    .join("  ")
    .trimEnd();
}

/** compact: one space-joined line per row, no header; empty → "(none)". */
function compactRows(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(none)";
  return rows.map((r) => rowCells(r).join(" ")).join("\n");
}

/** table: header row + aligned data rows; empty → header only + "(none)". */
function tableRows(rows: Record<string, unknown>[], header: string[]): string {
  if (rows.length === 0) return header.join("  ") + "\n(none)";
  const matrix = [header, ...rows.map(rowCells)];
  const widths = columnWidths(matrix);
  return matrix.map((r) => alignRow(r, widths)).join("\n");
}

/** Is this result a stats-style count-map (has by_* groups + totals)? */
function isStats(result: Record<string, unknown>): boolean {
  return isObject(result["totals"]) && Object.keys(result).some((k) => k.startsWith("by_"));
}

/** compact: terse grouped stats lines. */
function compactStats(result: Record<string, unknown>): string {
  const lines: string[] = [];
  const totals = result["totals"] as Record<string, unknown>;
  lines.push(
    Object.entries(totals)
      .map(([k, v]) => `${k}=${cell(v)}`)
      .join(" "),
  );
  for (const key of Object.keys(result)) {
    if (!key.startsWith("by_")) continue;
    const group = result[key];
    if (!isObject(group) || Object.keys(group).length === 0) continue;
    const body = Object.entries(group)
      .map(([k, v]) => `${k}=${cell(v)}`)
      .join(" ");
    lines.push(`${key.slice(3)}: ${body}`);
  }
  return lines.join("\n");
}

/**
 * compact: a flat / one-level-nested object as `key=value` lines.
 *   scalar       → key=value
 *   array        → key=[a,b]
 *   nested object→ key.sub=val per entry; an array-of-scalars value becomes
 *                  key.sub->a,b (the `related` grouping shape).
 */
function compactObject(result: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) {
      lines.push(`${key}=[${value.map(cell).join(",")}]`);
    } else if (isObject(value)) {
      for (const [sub, subVal] of Object.entries(value)) {
        if (Array.isArray(subVal)) {
          lines.push(`${key}.${sub}->${subVal.map(scalarRef).join(",")}`);
        } else {
          lines.push(`${key}.${sub}=${cell(subVal)}`);
        }
      }
    } else {
      lines.push(`${key}=${cell(value)}`);
    }
  }
  return lines.join("\n");
}

/** A nested array entry's reference: an object's `id` if present, else its scalar. */
function scalarRef(value: unknown): string {
  if (isObject(value) && "id" in value) return cell(value["id"]);
  return cell(value);
}

/** table: a non-row object as aligned `key   value` pairs. */
function tableObject(result: Record<string, unknown>): string {
  const pairs = Object.entries(result).map(([k, v]) => [
    k,
    isObject(v) || Array.isArray(v) ? JSON.stringify(v) : cell(v),
  ]);
  const keyWidth = Math.max(...pairs.map(([k]) => k!.length), 0);
  return pairs.map(([k, v]) => `${k!.padEnd(keyWidth)}  ${v}`).join("\n");
}

/**
 * Format a CLI result in the requested format. PURE.
 *
 * @param cliName the command name (reserved for future per-command nuance;
 *                the body stays generic and shape-driven).
 */
export function formatResult(cliName: string, result: unknown, fmt: Format): string {
  if (fmt === "json") return JSON.stringify(result);

  const rows = rowsOf(result);
  if (rows !== null) {
    return fmt === "table" ? tableRows(rows, headerFor(rows)) : compactRows(rows);
  }

  if (!isObject(result)) return cell(result);

  if (fmt === "compact") {
    return isStats(result) ? compactStats(result) : compactObject(result);
  }
  // table
  return tableObject(result);
}
