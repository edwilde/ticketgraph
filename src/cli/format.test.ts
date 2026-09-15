import { describe, it, expect } from "vitest";
import { formatResult, rowsOf, progressBar, type Format } from "./format.js";

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

/** The stats (count-map) fixture, shared with the progress regression test below. */
const statsFixture = {
  project: "proj1",
  by_status: { open: 9, in_progress: 1 },
  by_priority: { high: 4, low: 6 },
  by_epic: {},
  by_type: { feature: 10 },
  by_effort: { "3": 5 },
  totals: { tickets: 139, points: 11 },
};

describe("formatResult — stats (count-map)", () => {
  const stats = statsFixture;

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

/** A full ticket (the get/TicketFull shape: description, tags, relations). */
function ticketFull(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "T9",
    project_id: "proj1",
    title: "Add a timeout parameter",
    description: "Thread a timeout through fetchData and default it to 30s.",
    status: "open",
    priority: "high",
    type: "feature",
    effort: 3,
    epic: null,
    parent_id: null,
    created_by: "ed",
    created_at: "2026-01-01T00:00:00.000Z",
    closed_at: null,
    tags: ["backend", "net"],
    relations: {
      outgoing: { blocks: [{ id: "T10", note: null }] },
      incoming: {},
    },
    ...over,
  };
}

describe("formatResult — single ticket (add / get)", () => {
  it("compact add: one ticket-row line", () => {
    const out = formatResult("add", { ticket: ticketRow() }, "compact");
    expect(out.includes("\n")).toBe(false);
    expect(out).toBe("T1 open high feature 3 First ticket");
  });

  it("compact get: single {ticket} renders a detail block (not the 6-col row)", () => {
    const out = formatResult("get", { ticket: ticketFull() }, "compact");
    // Multi-line detail, not the single one-line list row.
    expect(out.includes("\n")).toBe(true);
    expect(out).not.toBe("T9 open high feature 3 Add a timeout parameter");
    expect(out).toContain("T9");
  });

  it("get compact shows description, tags and relations", () => {
    const out = formatResult("get", { ticket: ticketFull() }, "compact");
    expect(out).toContain("Thread a timeout through fetchData and default it to 30s.");
    expect(out).toContain("backend");
    expect(out).toContain("T10");
  });

  it("get compact formatting overhead is bounded (description is verbatim payload, chrome stays lean)", () => {
    // The description is rendered verbatim — it's the payload you asked for, so total
    // size scales with it and can't be capped. What T27 cares about is that the
    // *formatting overhead* (scalars/title/tags/relations labels) stays small. Pin it
    // by rendering a large body and asserting block size ≈ description size + a bounded constant.
    const body = "x".repeat(2000);
    const bytes = Buffer.byteLength(formatResult("get", { ticket: ticketFull({ description: body }) }, "compact"));
    const overhead = bytes - Buffer.byteLength(body);
    expect(overhead).toBeLessThan(250);
  });

  it("get batch renders each ticket", () => {
    const out = formatResult(
      "get",
      { tickets: [ticketFull({ id: "T9" }), ticketFull({ id: "T11", description: "Second body." })] },
      "compact",
    );
    const blocks = out.split("\n\n");
    expect(blocks).toHaveLength(2);
    expect(out).toContain("id=T9");
    expect(out).toContain("id=T11");
    expect(out).toContain("Second body.");
  });

  it("get batch null slot renders a non-blank not-found line", () => {
    const out = formatResult(
      "get",
      { tickets: [ticketFull({ id: "T9" }), null] },
      "compact",
    );
    const blocks = out.split("\n\n");
    expect(blocks).toHaveLength(2); // one block per array slot, positionally
    expect(blocks[1]!.trim().length).toBeGreaterThan(0);
    expect(out).toContain("(ticket not found)");
  });

  it("get renders recent_audit only when present", () => {
    const withAudit = formatResult(
      "get",
      {
        ticket: ticketFull({
          recent_audit: [
            { field: "status", old_value: "open", new_value: "done", changed_at: "2026-02-01T00:00:00.000Z" },
          ],
        }),
      },
      "compact",
    );
    expect(withAudit).toContain("audit:");
    expect(withAudit).toContain("status");

    const withoutAudit = formatResult("get", { ticket: ticketFull() }, "compact");
    expect(withoutAudit).not.toContain("audit:");
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

describe("progressBar", () => {
  it("38% -> 8 filled cells (round-to-nearest)", () => {
    expect(progressBar(38)).toBe("[########------------]");
  });

  it("0% -> all empty", () => {
    expect(progressBar(0)).toBe("[--------------------]");
  });

  it("100% -> all filled", () => {
    expect(progressBar(100)).toBe("[####################]");
  });

  it("matches the issue's worked examples", () => {
    expect(progressBar(21)).toBe("[####----------------]");
    expect(progressBar(30)).toBe("[######--------------]");
    expect(progressBar(67)).toBe("[#############-------]");
  });
});

describe("formatResult — progress", () => {
  /** The GitHub issue's headline example (no groups). */
  const headlineResult = {
    project: "proj1",
    totals: {
      tickets: 31,
      done_tickets: 12,
      points: 89,
      done_points: 34,
      pct: 38,
      unsized: 3,
      basis: "points" as const,
    },
    by_status: { open: 15, in_progress: 2, blocked: 2, done: 12 },
  };

  it("compact reproduces the issue's three headline lines verbatim", () => {
    const out = formatResult("progress", headlineResult, "compact");
    expect(out).toBe(
      [
        "progress 34/89 pts (38%) | 12/31 tickets",
        "open 15  in_progress 2  blocked 2  done 12  unsized 3",
        "[########------------] 38%",
      ].join("\n"),
    );
  });

  it("compact omits absent statuses and unsized when 0", () => {
    const out = formatResult(
      "progress",
      {
        project: "proj1",
        totals: {
          tickets: 5,
          done_tickets: 5,
          points: 10,
          done_points: 10,
          pct: 100,
          unsized: 0,
          basis: "points" as const,
        },
        by_status: { done: 5 },
      },
      "compact",
    );
    const statusLine = out.split("\n")[1];
    expect(statusLine).toBe("done 5");
    expect(out).not.toContain("unsized");
    expect(out).not.toContain("open 0");
    expect(out).not.toContain("blocked 0");
  });

  it("compact falls back to a tickets-based headline when basis is tickets", () => {
    const out = formatResult(
      "progress",
      {
        project: "proj1",
        totals: {
          tickets: 4,
          done_tickets: 1,
          points: 0,
          done_points: 0,
          pct: 25,
          unsized: 4,
          basis: "tickets" as const,
        },
        by_status: { open: 3, done: 1 },
      },
      "compact",
    );
    expect(out.split("\n")[0]).toBe("progress 0/0 pts (25% by tickets) | 1/4 tickets");
  });

  it("compact with groups: tool order, widest-key padding, rows end with pct%", () => {
    const withGroups = {
      ...headlineResult,
      groups: [
        { key: "frontend", tickets: 10, done_tickets: 2, points: 39, done_points: 8, pct: 21, unsized: 1 },
        { key: "infra", tickets: 6, done_tickets: 2, points: 20, done_points: 6, pct: 30, unsized: 0 },
        { key: "core", tickets: 8, done_tickets: 6, points: 30, done_points: 20, pct: 67, unsized: 2 },
      ],
    };
    const out = formatResult("progress", withGroups, "compact");
    const lines = out.split("\n");
    // 3 headline lines + blank + 3 group rows
    expect(lines).toHaveLength(7);
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("frontend   8/39  [####----------------] 21%");
    expect(lines[5]).toBe("infra      6/20  [######--------------] 30%");
    expect(lines[6]).toBe("core      20/30  [#############-------] 67%");
  });

  it("table with groups: header starts group/done/total/pct/unsized, data row uses points not tickets", () => {
    const group = { key: "frontend", tickets: 10, done_tickets: 2, points: 39, done_points: 8, pct: 21, unsized: 1 };
    const withGroups = { ...headlineResult, groups: [group] };
    const out = formatResult("progress", withGroups, "table");
    const lines = out.split("\n");
    // Three headline lines precede the group table.
    const headerLine = lines.find((l) => l.startsWith("group"));
    expect(headerLine).toBeDefined();
    expect(headerLine).toMatch(/^group\s+done\s+total\s+pct\s+unsized/);
    const dataLine = lines[lines.indexOf(headerLine!) + 1]!;
    const cols = dataLine.trim().split(/\s{2,}/);
    const [, done, total] = cols;
    expect(done).toBe(String(group.done_points));
    expect(total).toBe(String(group.points));
    expect(done).not.toBe(String(group.tickets));
    expect(total).not.toBe(String(group.tickets));
  });

  it("table with no groups equals compact output", () => {
    const compact = formatResult("progress", headlineResult, "compact");
    const table = formatResult("progress", headlineResult, "table");
    expect(table).toBe(compact);
  });

  it("json is untouched: equals JSON.stringify and contains no bar characters", () => {
    const withGroups = {
      ...headlineResult,
      groups: [
        { key: "frontend", tickets: 10, done_tickets: 2, points: 39, done_points: 8, pct: 21, unsized: 1 },
      ],
    };
    const out = formatResult("progress", withGroups, "json");
    expect(out).toBe(JSON.stringify(withGroups));
    expect(out).not.toContain("#");
    expect(out).not.toContain("[#");
  });

  it("regression: stats formatResult is unchanged and differs from progress rendering", () => {
    // Reuses the fixture from the "formatResult — stats (count-map)" describe block above,
    // rather than a second hand-declared copy.
    const out = formatResult("stats", statsFixture, "compact");
    const lines = out.split("\n");
    expect(lines[0]).toBe("tickets=139 points=11");
    expect(out).toContain("status: open=9 in_progress=1");

    // Same object rendered through the progress renderer would differ (no "progress" headline,
    // no bar): confirms cliName routing, not shape-sniffing, decides the renderer.
    const asProgress = formatResult("progress", statsFixture, "compact");
    expect(asProgress).not.toBe(out);
    expect(asProgress).toContain("progress");
  });

  it("compact with an empty project (no statuses, nothing unsized) omits the blank status line", () => {
    const out = formatResult(
      "progress",
      {
        project: "proj1",
        totals: {
          tickets: 0,
          done_tickets: 0,
          points: 0,
          done_points: 0,
          pct: 0,
          unsized: 0,
          basis: "tickets" as const,
        },
        by_status: {},
      },
      "compact",
    );
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("progress 0/0 pts (0% by tickets) | 0/0 tickets");
    expect(lines[1]).toBe("[--------------------] 0%");
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
