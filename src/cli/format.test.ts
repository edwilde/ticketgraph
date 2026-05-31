import { describe, it, expect } from "vitest";
import { formatResult, rowsOf, type Format } from "./format.js";

/** A representative ticket row (all ticket columns present). */
function ticketRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "T1",
    project_id: "proj1",
    title: "First ticket",
    status: "open",
    priority: "high",
    type: "feature",
    effort: 3,
    epic: null,
    parent_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    closed_at: null,
    ...over,
  };
}

describe("rowsOf", () => {
  it("returns the rows array for a list result", () => {
    const r = { project: "p", count: 2, rows: [ticketRow(), ticketRow({ id: "T2" })] };
    expect(rowsOf(r)).toHaveLength(2);
  });

  it("prefers the first present row-collection key (hits for search)", () => {
    const r = { project: "p", count: 1, hits: [ticketRow()] };
    expect(rowsOf(r)).toHaveLength(1);
  });

  it("wraps a single {ticket} as a one-row collection", () => {
    const rows = rowsOf({ ticket: ticketRow() });
    expect(rows).toHaveLength(1);
    expect(rows![0]!["id"]).toBe("T1");
  });

  it("returns null for a flat object (link) and a count-map (stats)", () => {
    expect(rowsOf({ from: "T1", to: "T2", kind: "blocks" })).toBeNull();
    expect(rowsOf({ totals: { tickets: 1 }, by_status: {} })).toBeNull();
  });

  it("returns an empty array for an empty collection", () => {
    expect(rowsOf({ project: "p", count: 0, rows: [] })).toEqual([]);
  });
});

describe("formatResult — json", () => {
  it("round-trips byte-identically to JSON.stringify (single line)", () => {
    const r = { project: "p", count: 1, rows: [ticketRow()] };
    const out = formatResult("list", r, "json");
    expect(out).toBe(JSON.stringify(r));
    expect(out.includes("\n")).toBe(false);
    expect(JSON.parse(out)).toEqual(r);
  });
});

describe("formatResult — list (row collection)", () => {
  const result = {
    project: "proj1",
    count: 2,
    rows: [
      ticketRow({ id: "T1", priority: "high", effort: 3, title: "First" }),
      ticketRow({ id: "T2", priority: null, effort: null, title: "Second" }),
    ],
  };

  it("compact: one line per row, no header, single-space joined", () => {
    const out = formatResult("list", result, "compact");
    const lines = out.split("\n");
    expect(lines).toHaveLength(2); // no header line
    // id status priority type effort title
    expect(lines[0]).toBe("T1 open high feature 3 First");
  });

  it("compact: null priority/effort render as '-'", () => {
    const out = formatResult("list", result, "compact");
    const lines = out.split("\n");
    expect(lines[1]).toBe("T2 open - feature - Second");
  });

  it("compact is shorter than json for a multi-row list", () => {
    const compact = formatResult("list", result, "compact");
    const json = formatResult("list", result, "json");
    expect(compact.length).toBeLessThan(json.length);
  });

  it("table: a header row plus aligned data rows", () => {
    const out = formatResult("list", result, "table");
    const lines = out.split("\n");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[0]).toContain("id");
    expect(lines[0]).toContain("status");
    expect(lines[0]).toContain("title");
    // Alignment: the status column starts at the same offset on every line.
    const statusCol = lines[0]!.indexOf("status");
    expect(lines[1]!.indexOf("open")).toBe(statusCol);
    expect(lines[2]!.indexOf("open")).toBe(statusCol);
  });

  it("json round-trips a list via JSON.parse", () => {
    const parsed = JSON.parse(formatResult("list", result, "json")) as typeof result;
    expect(parsed.rows[0]!["id"]).toBe("T1");
    // Lossless: full title + all columns survive (no truncation in json).
    expect(parsed.rows).toHaveLength(2);
  });

  it("compact truncates a long title to ~60 chars (display only)", () => {
    const long = "x".repeat(120);
    const out = formatResult(
      "list",
      { project: "p", count: 1, rows: [ticketRow({ title: long })] },
      "compact",
    );
    const titleCell = out.split(" ").slice(5).join(" ");
    expect(titleCell.length).toBeLessThanOrEqual(60);
    expect(titleCell.endsWith("…")).toBe(true);
    // json stays lossless.
    const json = JSON.parse(
      formatResult("list", { project: "p", count: 1, rows: [ticketRow({ title: long })] }, "json"),
    ) as { rows: Array<{ title: string }> };
    expect(json.rows[0]!.title).toBe(long);
  });
});

describe("formatResult — empty collection", () => {
  it("compact: empty rows render as (none)", () => {
    expect(formatResult("list", { project: "p", count: 0, rows: [] }, "compact")).toBe("(none)");
  });

  it("table: empty rows renders header + (none) without throwing", () => {
    const out = formatResult("list", { project: "p", count: 0, rows: [] }, "table");
    const lines = out.split("\n");
    // Header line uses ticket columns (the safe default for an empty collection).
    expect(lines[0]).toContain("id");
    expect(lines[0]).toContain("title");
    expect(lines[1]).toBe("(none)");
  });
});

describe("formatResult — stats (count-map)", () => {
  const stats = {
    project: "proj1",
    by_status: { open: 9, in_progress: 1 },
    by_priority: { high: 4, low: 6 },
    by_epic: {},
    by_type: { feature: 10 },
    by_effort: { "3": 5 },
    totals: { tickets: 139, points: 11 },
  };

  it("compact: terse totals line then one grouped line per by_* group", () => {
    const out = formatResult("stats", stats, "compact");
    const lines = out.split("\n");
    expect(lines[0]).toBe("tickets=139 points=11");
    expect(out).toContain("status: open=9 in_progress=1");
    expect(out).toContain("priority: high=4 low=6");
    expect(out).toContain("type: feature=10");
    // Empty by_epic: {} must not produce a stray "epic: " noise line.
    expect(out).not.toContain("epic:");
  });
});

describe("formatResult — single ticket (add / get)", () => {
  it("compact add: one ticket-row line", () => {
    const out = formatResult("add", { ticket: ticketRow() }, "compact");
    expect(out.includes("\n")).toBe(false);
    expect(out).toBe("T1 open high feature 3 First ticket");
  });

  it("compact get: single {ticket} renders one line", () => {
    const out = formatResult("get", { ticket: ticketRow({ id: "T9" }) }, "compact");
    expect(out.startsWith("T9 ")).toBe(true);
  });
});

describe("formatResult — link (flat object)", () => {
  const link = {
    from: "T1",
    to: "T2",
    kind: "blocks",
    note: "because",
    created_at: "2026-01-01T00:00:00.000Z",
  };

  it("compact: one key=value line per field", () => {
    const out = formatResult("link", link, "compact");
    expect(out).toContain("from=T1");
    expect(out).toContain("to=T2");
    expect(out).toContain("kind=blocks");
  });

  it("table: aligned key   value pairs", () => {
    const out = formatResult("link", link, "table");
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^from\s+T1$/);
    expect(lines[2]).toMatch(/^kind\s+blocks$/);
  });
});

describe("formatResult — related (one-level nested)", () => {
  it("compact: grouped kind->ids per direction", () => {
    const related = {
      id: "T1",
      outgoing: { blocks: [{ id: "T2" }, { id: "T3" }] },
      incoming: {},
    };
    const out = formatResult("related", related, "compact");
    expect(out).toContain("id=T1");
    expect(out).toContain("outgoing.blocks->T2,T3");
  });
});

describe("formatResult — add_many (arrays)", () => {
  it("compact: array fields render as k=[a,b]", () => {
    const out = formatResult(
      "add_many",
      { created: ["X1", "X2"], count: 2 },
      "compact",
    );
    expect(out).toContain("created=[X1,X2]");
    expect(out).toContain("count=2");
  });
});

describe("TASK 4 — token-delta measurement (compact vs json)", () => {
  it("compact is materially shorter than json on a seeded multi-row list", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      ticketRow({ id: `T${i + 1}`, title: `Ticket number ${i + 1}` }),
    );
    const result = { project: "proj1", count: rows.length, rows };
    const compact = formatResult("list", result, "compact");
    const json = formatResult("list", result, "json");
    const delta = json.length - compact.length;
    // Token proxy (mirrors T20): record the measured char delta.
    const fmt: Format = "compact";
    expect(fmt).toBe("compact");
    expect(compact.length).toBeLessThan(json.length);
    // The win must be substantial, not a single byte.
    expect(delta).toBeGreaterThan(json.length * 0.4);
    // Surface the measured numbers in the test output for the report.
    console.log(
      `[token-delta] json=${json.length} compact=${compact.length} delta=${delta} (${((delta / json.length) * 100).toFixed(1)}% smaller)`,
    );
  });
});
