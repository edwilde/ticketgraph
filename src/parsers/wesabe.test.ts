import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWesabe } from "./wesabe.js";
import { validateImportFile } from "../lib/import-format.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "../../tests/fixtures/wesabe");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

// ---------------------------------------------------------------------------
// Fixture 01: done-with-output-blockquote
// ---------------------------------------------------------------------------
describe("fixture 01: done-with-output-blockquote", () => {
  it("parses EXPLORE-01 id and title", () => {
    const result = parseWesabe(fixture("01-done-with-output-blockquote.md"));
    const t = result.tickets.find((t) => t.id === "EXPLORE-01");
    expect(t).toBeDefined();
    expect(t!.title).toBe("Deep-dive the brcm-accounts-api source");
  });

  it("EXPLORE-01 has status=done", () => {
    const result = parseWesabe(fixture("01-done-with-output-blockquote.md"));
    expect(result.tickets.find((t) => t.id === "EXPLORE-01")!.status).toBe("done");
  });

  it("EXPLORE-01 description contains blockquote output line", () => {
    const result = parseWesabe(fixture("01-done-with-output-blockquote.md"));
    const desc = result.tickets.find((t) => t.id === "EXPLORE-01")!.description ?? "";
    expect(desc).toContain("api-endpoints.md");
  });

  it("EXPLORE-01 has epic 'Exploration & Spike' (ALL DONE stripped)", () => {
    const result = parseWesabe(fixture("01-done-with-output-blockquote.md"));
    const epic = result.tickets.find((t) => t.id === "EXPLORE-01")!.epic;
    expect(epic).not.toContain("ALL DONE");
    expect(epic).toContain("Exploration");
  });

  it("created_by is migrated:wesabe", () => {
    const result = parseWesabe(fixture("01-done-with-output-blockquote.md"));
    expect(result.tickets[0]!.created_by).toBe("migrated:wesabe");
  });

  it("project_id is wesabe", () => {
    expect(parseWesabe(fixture("01-done-with-output-blockquote.md")).project_id).toBe("wesabe");
  });

  it("passes validateImportFile", () => {
    expect(() =>
      validateImportFile(parseWesabe(fixture("01-done-with-output-blockquote.md"))),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fixture 02: open-no-status
// ---------------------------------------------------------------------------
describe("fixture 02: open-no-status", () => {
  it("SETUP-02 has status=open when no inline status", () => {
    const result = parseWesabe(fixture("02-open-no-status.md"));
    const t = result.tickets.find((t) => t.id === "SETUP-02");
    expect(t).toBeDefined();
    expect(t!.status).toBe("open");
  });

  it("SETUP-02 has type=task (SETUP namespace)", () => {
    const result = parseWesabe(fixture("02-open-no-status.md"));
    expect(result.tickets.find((t) => t.id === "SETUP-02")!.type).toBe("task");
  });

  it("SETUP-02 has tag 'setup'", () => {
    const result = parseWesabe(fixture("02-open-no-status.md"));
    expect(result.tickets.find((t) => t.id === "SETUP-02")!.tags).toContain("setup");
  });

  it("SETUP-02 epic is 'Project Setup'", () => {
    const result = parseWesabe(fixture("02-open-no-status.md"));
    expect(result.tickets.find((t) => t.id === "SETUP-02")!.epic).toBe("Project Setup");
  });
});

// ---------------------------------------------------------------------------
// Fixture 03: blocked-by-with-checkmark
// ---------------------------------------------------------------------------
describe("fixture 03: blocked-by-with-checkmark", () => {
  it("SETUP-01 blocked by EXPLORE-04 ✅ produces blocks relation", () => {
    const result = parseWesabe(fixture("03-blocked-by-with-checkmark.md"));
    const rel = result.relations?.find(
      (r) => r.from === "EXPLORE-04" && r.to === "SETUP-01" && r.kind === "blocks",
    );
    expect(rel).toBeDefined();
  });

  it("SETUP-01 has status=done", () => {
    const result = parseWesabe(fixture("03-blocked-by-with-checkmark.md"));
    expect(result.tickets.find((t) => t.id === "SETUP-01")!.status).toBe("done");
  });

  it("blocked-by line is NOT included in description", () => {
    const result = parseWesabe(fixture("03-blocked-by-with-checkmark.md"));
    const desc = result.tickets.find((t) => t.id === "SETUP-01")!.description ?? "";
    expect(desc).not.toContain("Blocked by");
  });
});

// ---------------------------------------------------------------------------
// Fixture 04: multi-blocked-by
// ---------------------------------------------------------------------------
describe("fixture 04: multi-blocked-by", () => {
  it("API-05 blocked by MODEL-06 and EXPLORE-01 (both ✅) produces two relations", () => {
    const result = parseWesabe(fixture("04-multi-blocked-by.md"));
    const rels = result.relations?.filter((r) => r.to === "API-05" && r.kind === "blocks") ?? [];
    const fromIds = rels.map((r) => r.from).sort();
    expect(fromIds).toContain("MODEL-06");
    expect(fromIds).toContain("EXPLORE-01");
    expect(fromIds).toHaveLength(2);
  });

  it("relations have from=blocker, to=ticket (correct direction)", () => {
    const result = parseWesabe(fixture("04-multi-blocked-by.md"));
    const rel = result.relations?.find((r) => r.from === "MODEL-06" && r.to === "API-05");
    expect(rel).toBeDefined();
    expect(rel!.kind).toBe("blocks");
  });
});

// ---------------------------------------------------------------------------
// Fixture 05: bug-type
// ---------------------------------------------------------------------------
describe("fixture 05: bug-type", () => {
  it("BUG-01 has type=bug", () => {
    const result = parseWesabe(fixture("05-bug-type.md"));
    const t = result.tickets.find((t) => t.id === "BUG-01");
    expect(t).toBeDefined();
    expect(t!.type).toBe("bug");
  });

  it("BUG-01 has tag 'bug'", () => {
    const result = parseWesabe(fixture("05-bug-type.md"));
    expect(result.tickets.find((t) => t.id === "BUG-01")!.tags).toContain("bug");
  });

  it("BUG-01 has status=done", () => {
    const result = parseWesabe(fixture("05-bug-type.md"));
    expect(result.tickets.find((t) => t.id === "BUG-01")!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Fixture 06: ux-type-tag
// ---------------------------------------------------------------------------
describe("fixture 06: ux-type-tag", () => {
  it("UX-01 has type=task", () => {
    const result = parseWesabe(fixture("06-ux-type-tag.md"));
    const t = result.tickets.find((t) => t.id === "UX-01");
    expect(t).toBeDefined();
    expect(t!.type).toBe("task");
  });

  it("UX-01 has tag 'ux'", () => {
    const result = parseWesabe(fixture("06-ux-type-tag.md"));
    expect(result.tickets.find((t) => t.id === "UX-01")!.tags).toContain("ux");
  });

  it("UX-01 has status=open (no inline status)", () => {
    const result = parseWesabe(fixture("06-ux-type-tag.md"));
    expect(result.tickets.find((t) => t.id === "UX-01")!.status).toBe("open");
  });

  it("UX-01 blocked by AUTH-02 produces blocks relation", () => {
    const result = parseWesabe(fixture("06-ux-type-tag.md"));
    const rel = result.relations?.find(
      (r) => r.from === "AUTH-02" && r.to === "UX-01" && r.kind === "blocks",
    );
    expect(rel).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fixture 07: design-type-tag
// ---------------------------------------------------------------------------
describe("fixture 07: design-type-tag", () => {
  it("DESIGN-01 has type=task", () => {
    const result = parseWesabe(fixture("07-design-type-tag.md"));
    const t = result.tickets.find((t) => t.id === "DESIGN-01");
    expect(t).toBeDefined();
    expect(t!.type).toBe("task");
  });

  it("DESIGN-01 has tag 'design'", () => {
    const result = parseWesabe(fixture("07-design-type-tag.md"));
    expect(result.tickets.find((t) => t.id === "DESIGN-01")!.tags).toContain("design");
  });

  it("DESIGN-01 has status=done", () => {
    const result = parseWesabe(fixture("07-design-type-tag.md"));
    expect(result.tickets.find((t) => t.id === "DESIGN-01")!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Fixture 08: epic-boundary
// ---------------------------------------------------------------------------
describe("fixture 08: epic-boundary", () => {
  it("EXPLORE-01 and EXPLORE-04 share the same epic (Exploration & Spike)", () => {
    const result = parseWesabe(fixture("08-epic-boundary.md"));
    const e1 = result.tickets.find((t) => t.id === "EXPLORE-01")!;
    const e4 = result.tickets.find((t) => t.id === "EXPLORE-04")!;
    expect(e1.epic).toBe(e4.epic);
    expect(e1.epic).not.toContain("ALL DONE");
  });

  it("SETUP-01 is in a different epic (Project Setup)", () => {
    const result = parseWesabe(fixture("08-epic-boundary.md"));
    const s1 = result.tickets.find((t) => t.id === "SETUP-01")!;
    expect(s1.epic).toBe("Project Setup");
  });

  it("SETUP-01 blocked by EXPLORE-04 (from a different epic)", () => {
    const result = parseWesabe(fixture("08-epic-boundary.md"));
    const rel = result.relations?.find(
      (r) => r.from === "EXPLORE-04" && r.to === "SETUP-01" && r.kind === "blocks",
    );
    expect(rel).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fixture 09: ac-block
// ---------------------------------------------------------------------------
describe("fixture 09: ac-block", () => {
  it("MODEL-03 description contains AC bullet", () => {
    const result = parseWesabe(fixture("09-ac-block.md"));
    const desc = result.tickets.find((t) => t.id === "MODEL-03")!.description ?? "";
    expect(desc).toContain("**AC:**");
  });

  it("MODEL-03 has status=done", () => {
    const result = parseWesabe(fixture("09-ac-block.md"));
    expect(result.tickets.find((t) => t.id === "MODEL-03")!.status).toBe("done");
  });

  it("MODEL-03 blocked by MODEL-01 and MODEL-02", () => {
    const result = parseWesabe(fixture("09-ac-block.md"));
    const rels = result.relations?.filter((r) => r.to === "MODEL-03" && r.kind === "blocks") ?? [];
    const fromIds = rels.map((r) => r.from).sort();
    expect(fromIds).toContain("MODEL-01");
    expect(fromIds).toContain("MODEL-02");
  });
});

// ---------------------------------------------------------------------------
// Fixture 10: feat-type-tag
// ---------------------------------------------------------------------------
describe("fixture 10: feat-type-tag", () => {
  it("FEAT-01 has type=task (FEAT namespace)", () => {
    const result = parseWesabe(fixture("10-feat-type-tag.md"));
    const t = result.tickets.find((t) => t.id === "FEAT-01");
    expect(t).toBeDefined();
    expect(t!.type).toBe("task");
  });

  it("FEAT-01 has tag 'feat'", () => {
    const result = parseWesabe(fixture("10-feat-type-tag.md"));
    expect(result.tickets.find((t) => t.id === "FEAT-01")!.tags).toContain("feat");
  });

  it("FEAT-01 has status=done", () => {
    const result = parseWesabe(fixture("10-feat-type-tag.md"));
    expect(result.tickets.find((t) => t.id === "FEAT-01")!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Fixture 11: inline-status-variants
// ---------------------------------------------------------------------------
describe("fixture 11: inline-status-variants", () => {
  it("TEST-01 has status=open (no inline status)", () => {
    const result = parseWesabe(fixture("11-inline-status-variants.md"));
    expect(result.tickets.find((t) => t.id === "TEST-01")!.status).toBe("open");
  });

  it("TEST-02 has status=deferred", () => {
    const result = parseWesabe(fixture("11-inline-status-variants.md"));
    expect(result.tickets.find((t) => t.id === "TEST-02")!.status).toBe("deferred");
  });

  it("TEST-03 has status=in_progress", () => {
    const result = parseWesabe(fixture("11-inline-status-variants.md"));
    expect(result.tickets.find((t) => t.id === "TEST-03")!.status).toBe("in_progress");
  });

  it("TEST-04 has status=blocked", () => {
    const result = parseWesabe(fixture("11-inline-status-variants.md"));
    expect(result.tickets.find((t) => t.id === "TEST-04")!.status).toBe("blocked");
  });

  it("TEST-03 blocked by TEST-01 produces blocks relation", () => {
    const result = parseWesabe(fixture("11-inline-status-variants.md"));
    const rel = result.relations?.find(
      (r) => r.from === "TEST-01" && r.to === "TEST-03" && r.kind === "blocks",
    );
    expect(rel).toBeDefined();
  });

  it("TEST-04 blocked by TEST-02 and TEST-03 produces two relations", () => {
    const result = parseWesabe(fixture("11-inline-status-variants.md"));
    const rels = result.relations?.filter((r) => r.to === "TEST-04" && r.kind === "blocks") ?? [];
    const fromIds = rels.map((r) => r.from).sort();
    expect(fromIds).toContain("TEST-02");
    expect(fromIds).toContain("TEST-03");
  });
});

// ---------------------------------------------------------------------------
// Fixture 12: epic-all-done-strip
// ---------------------------------------------------------------------------
describe("fixture 12: epic-all-done-strip", () => {
  it("EXPLORE-02 epic name has '— ALL DONE' stripped", () => {
    const result = parseWesabe(fixture("12-epic-all-done-strip.md"));
    const t = result.tickets.find((t) => t.id === "EXPLORE-02");
    expect(t).toBeDefined();
    expect(t!.epic).not.toContain("ALL DONE");
  });

  it("EXPLORE-02 epic is 'Exploration & Spike'", () => {
    const result = parseWesabe(fixture("12-epic-all-done-strip.md"));
    expect(result.tickets.find((t) => t.id === "EXPLORE-02")!.epic).toBe("Exploration & Spike");
  });

  it("EXPLORE-03 shares the same stripped epic name", () => {
    const result = parseWesabe(fixture("12-epic-all-done-strip.md"));
    const e2 = result.tickets.find((t) => t.id === "EXPLORE-02")!;
    const e3 = result.tickets.find((t) => t.id === "EXPLORE-03")!;
    expect(e2.epic).toBe(e3.epic);
  });
});
