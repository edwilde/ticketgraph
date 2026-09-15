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

/** Scalar header fields for a ticket detail block, in display order. */
const DETAIL_SCALARS = [
  "id",
  "status",
  "priority",
  "type",
  "effort",
  "epic",
  "parent_id",
  "created_by",
  "created_at",
  "closed_at",
] as const;

/**
 * Render one full ticket (the get/TicketFull shape) as a multi-line detail
 * block: a scalar header line, the title, the description VERBATIM, tags, and
 * relations grouped by direction+kind (reusing the `kind->ids` convention from
 * compactObject). recent_audit is rendered only when present.
 */
function ticketDetail(t: Record<string, unknown>): string {
  const lines: string[] = [];

  lines.push(
    DETAIL_SCALARS.filter((k) => k in t)
      .map((k) => `${k}=${cell(t[k])}`)
      .join(" "),
  );

  if ("title" in t) lines.push(`title: ${cell(t["title"])}`);
  if ("description" in t) lines.push(`description: ${cell(t["description"])}`);

  const tags = t["tags"];
  if (Array.isArray(tags)) lines.push(`tags=[${tags.map(cell).join(",")}]`);

  const relations = t["relations"];
  if (isObject(relations)) {
    for (const dir of ["outgoing", "incoming"] as const) {
      const group = relations[dir];
      if (!isObject(group)) continue;
      for (const [kind, refs] of Object.entries(group)) {
        if (Array.isArray(refs) && refs.length > 0) {
          lines.push(`${dir}.${kind}->${refs.map(scalarRef).join(",")}`);
        }
      }
    }
  }

  const audit = t["recent_audit"];
  if (Array.isArray(audit)) {
    for (const entry of audit) {
      if (isObject(entry)) {
        lines.push(
          `audit: ${cell(entry["changed_at"])} ${cell(entry["field"])} ${cell(entry["old_value"])}->${cell(entry["new_value"])}`,
        );
      }
    }
  }

  return lines.join("\n");
}

/**
 * Render a get result (single `{ticket}` or batch `{tickets:[…]}`) as one or
 * more detail blocks. compact and table share this renderer (a single ticket is
 * not a multi-row table). A null entry renders a clear not-found line.
 */
function formatGetDetail(result: unknown, _fmt: Format): string {
  if (!isObject(result)) return cell(result);

  const NOT_FOUND = "(ticket not found)";

  if (Array.isArray(result["tickets"])) {
    const tickets = result["tickets"] as unknown[];
    return tickets
      .map((t) => (isObject(t) ? ticketDetail(t) : NOT_FOUND))
      .join("\n\n");
  }

  const ticket = result["ticket"];
  return isObject(ticket) ? ticketDetail(ticket) : NOT_FOUND;
}

/** Fixed display order for `by_status` keys in the progress headline. */
const PROGRESS_STATUS_ORDER = ["open", "in_progress", "blocked", "done"] as const;

/**
 * A 20-cell text progress bar: `#` filled, `-` empty, wrapped in `[` `]`.
 * Filled count rounds to nearest cell (round-to-nearest, not floor/ceil), so
 * e.g. 38% -> 8 filled, matching the issue's worked examples.
 */
export function progressBar(pct: number): string {
  const filled = Math.max(0, Math.min(20, Math.round(pct / 5)));
  return `[${"#".repeat(filled)}${"-".repeat(20 - filled)}]`;
}

/** One progress group row (compact): key padded, points fraction right-aligned, bar, pct. */
function progressGroupRow(
  group: Record<string, unknown>,
  keyWidth: number,
  fracWidth: number,
): string {
  const key = cell(group["key"]);
  const fraction = `${cell(group["done_points"])}/${cell(group["points"])}`;
  const pct = Number(group["pct"]);
  return `${key.padEnd(keyWidth)}  ${fraction.padStart(fracWidth)}  ${progressBar(pct)} ${pct}%`;
}

/** compact: the three headline lines (fixed status order, blank-when-zero unsized). */
function progressHeadline(result: Record<string, unknown>): string[] {
  const totals = result["totals"] as Record<string, unknown>;
  const byStatus = (result["by_status"] as Record<string, unknown>) ?? {};
  const pct = Number(totals["pct"]);
  const basis = totals["basis"];
  const pctLabel = basis === "tickets" ? `${pct}% by tickets` : `${pct}%`;

  const lines: string[] = [];
  lines.push(
    `progress ${cell(totals["done_points"])}/${cell(totals["points"])} pts (${pctLabel}) | ${cell(
      totals["done_tickets"],
    )}/${cell(totals["tickets"])} tickets`,
  );

  const statusParts = PROGRESS_STATUS_ORDER.filter((k) => k in byStatus).map(
    (k) => `${k} ${cell(byStatus[k])}`,
  );
  const unsized = Number(totals["unsized"] ?? 0);
  if (unsized > 0) statusParts.push(`unsized ${unsized}`);
  if (statusParts.length > 0) lines.push(statusParts.join("  "));

  lines.push(`${progressBar(pct)} ${pct}%`);
  return lines;
}

/** compact: headline + (blank line + one row per group, in tool order) when groups present. */
function compactProgress(result: Record<string, unknown>): string {
  const lines = progressHeadline(result);
  const groups = result["groups"];
  if (Array.isArray(groups) && groups.length > 0) {
    const rows = groups.filter(isObject);
    // Floor with 0: an all-non-object `groups` array leaves `rows` empty, and
    // Math.max() over an empty spread is -Infinity.
    const keyWidth = Math.max(0, ...rows.map((g) => cell(g["key"]).length));
    const fracWidth = Math.max(
      0,
      ...rows.map((g) => `${cell(g["done_points"])}/${cell(g["points"])}`.length),
    );
    lines.push("");
    for (const g of rows) lines.push(progressGroupRow(g, keyWidth, fracWidth));
  }
  return lines.join("\n");
}

/** table: headline + a `group done total pct unsized` table (points-based, no bar) when groups present. */
function tableProgress(result: Record<string, unknown>): string {
  const lines = progressHeadline(result);
  const groups = result["groups"];
  if (Array.isArray(groups) && groups.length > 0) {
    const rows = groups.filter(isObject).map((g) => ({
      group: cell(g["key"]),
      done: cell(g["done_points"]),
      total: cell(g["points"]),
      pct: `${cell(g["pct"])}%`,
      unsized: cell(g["unsized"]),
    }));
    lines.push("");
    lines.push(tableRows(rows, ["group", "done", "total", "pct", "unsized"]));
  }
  return lines.join("\n");
}

/** Route to the compact or table progress renderer. compact === table when there are no groups. */
function formatProgress(result: unknown, fmt: Format): string {
  if (!isObject(result)) return cell(result);
  return fmt === "table" ? tableProgress(result) : compactProgress(result);
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

  // get renders a full detail block, not the truncated 6-col list row. This
  // MUST precede rowsOf, which already wraps `{ticket}`/`{tickets}` as rows.
  if (cliName === "get") return formatGetDetail(result, fmt);

  // progress has its own headline+bar layout, keyed off cliName (not shape) so it
  // never collides with isStats, which the totals/by_status shape would otherwise match.
  if (cliName === "progress") return formatProgress(result, fmt);

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
