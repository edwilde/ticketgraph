import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSscloud } from "./sscloud.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "../../tests/fixtures/sscloud");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

// ---------------------------------------------------------------------------
// Fixture 01: done-with-commit
// ---------------------------------------------------------------------------
describe("fixture 01: done-with-commit", () => {
  it("parses T1 id and title", () => {
    const result = parseSscloud(fixture("01-done-with-commit.md"));
    const t1 = result.tickets.find((t) => t.id === "T1");
    expect(t1).toBeDefined();
    expect(t1!.title).toBe("Project scaffold");
  });

  it("T1 has status=done", () => {
    const result = parseSscloud(fixture("01-done-with-commit.md"));
    expect(result.tickets.find((t) => t.id === "T1")!.status).toBe("done");
  });

  it("T1 has P0 priority and Foundation epic", () => {
    const result = parseSscloud(fixture("01-done-with-commit.md"));
    const t1 = result.tickets.find((t) => t.id === "T1")!;
    expect(t1.priority).toBe("P0");
    expect(t1.epic).toBe("Foundation");
  });

  it("created_by is migrated:sscloud", () => {
    const result = parseSscloud(fixture("01-done-with-commit.md"));
    expect(result.tickets[0]!.created_by).toBe("migrated:sscloud");
  });

  it("project_id is sscloud", () => {
    expect(parseSscloud(fixture("01-done-with-commit.md")).project_id).toBe("sscloud");
  });
});

// ---------------------------------------------------------------------------
// Fixture 02: open-no-status
// ---------------------------------------------------------------------------
describe("fixture 02: open-no-status", () => {
  it("T4 has status=open when Status line is absent", () => {
    const result = parseSscloud(fixture("02-open-no-status.md"));
    const t4 = result.tickets.find((t) => t.id === "T4");
    expect(t4).toBeDefined();
    expect(t4!.status).toBe("open");
  });

  it("T4 title contains backticks", () => {
    const result = parseSscloud(fixture("02-open-no-status.md"));
    const t4 = result.tickets.find((t) => t.id === "T4")!;
    expect(t4.title).toContain("`sscloud login`");
  });

  it("T4 has P1 priority", () => {
    const result = parseSscloud(fixture("02-open-no-status.md"));
    expect(result.tickets.find((t) => t.id === "T4")!.priority).toBe("P1");
  });

  it("T4 has epic 'Auth + linking'", () => {
    const result = parseSscloud(fixture("02-open-no-status.md"));
    expect(result.tickets.find((t) => t.id === "T4")!.epic).toBe("Auth + linking");
  });

  it("T1 blocker produces blocks relation", () => {
    const result = parseSscloud(fixture("02-open-no-status.md"));
    const rel = result.relations?.find((r) => r.from === "T1" && r.to === "T4" && r.kind === "blocks");
    expect(rel).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fixture 03: blockers-with-prose (T8 + T3)
// ---------------------------------------------------------------------------
describe("fixture 03: blockers-with-prose", () => {
  it("T8 blockers T2 and T3 produce blocks relations", () => {
    const result = parseSscloud(fixture("03-blockers-with-prose.md"));
    const rels = result.relations?.filter((r) => r.to === "T8" && r.kind === "blocks") ?? [];
    const fromIds = rels.map((r) => r.from).sort();
    expect(fromIds).toContain("T2");
    expect(fromIds).toContain("T3");
  });

  it("T3 has status=done", () => {
    const result = parseSscloud(fixture("03-blockers-with-prose.md"));
    expect(result.tickets.find((t) => t.id === "T3")!.status).toBe("done");
  });

  it("T8 has status=open (no status line)", () => {
    const result = parseSscloud(fixture("03-blockers-with-prose.md"));
    expect(result.tickets.find((t) => t.id === "T8")!.status).toBe("open");
  });

  it("'Tracked as T60' in T3 creates follows_up relation", () => {
    const result = parseSscloud(fixture("03-blockers-with-prose.md"));
    const rel = result.relations?.find(
      (r) => r.from === "T3" && r.to === "T60" && r.kind === "follows_up",
    );
    expect(rel).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fixture 04: blockers-none
// ---------------------------------------------------------------------------
describe("fixture 04: blockers-none", () => {
  it("T17 with 'Blockers: none' emits no blocks relations", () => {
    const result = parseSscloud(fixture("04-blockers-none.md"));
    const blocksRels = result.relations?.filter((r) => r.to === "T17" && r.kind === "blocks") ?? [];
    expect(blocksRels).toHaveLength(0);
  });

  it("T17 has status=open (no status line)", () => {
    const result = parseSscloud(fixture("04-blockers-none.md"));
    expect(result.tickets.find((t) => t.id === "T17")!.status).toBe("open");
  });

  it("T17 has P2 priority", () => {
    const result = parseSscloud(fixture("04-blockers-none.md"));
    expect(result.tickets.find((t) => t.id === "T17")!.priority).toBe("P2");
  });
});

// ---------------------------------------------------------------------------
// Fixture 05: superseded
// ---------------------------------------------------------------------------
describe("fixture 05: superseded", () => {
  it("T41 status=done", () => {
    const result = parseSscloud(fixture("05-superseded.md"));
    expect(result.tickets.find((t) => t.id === "T41")!.status).toBe("done");
  });

  it("'Superseded by T70' creates T41 supersedes T70 relation", () => {
    const result = parseSscloud(fixture("05-superseded.md"));
    const rel = result.relations?.find(
      (r) => r.from === "T41" && r.to === "T70" && r.kind === "supersedes",
    );
    expect(rel).toBeDefined();
  });

  it("T41 blockers T34 and T40 create blocks relations", () => {
    const result = parseSscloud(fixture("05-superseded.md"));
    const rels = result.relations?.filter((r) => r.to === "T41" && r.kind === "blocks") ?? [];
    const fromIds = rels.map((r) => r.from).sort();
    expect(fromIds).toContain("T34");
    expect(fromIds).toContain("T40");
  });
});

// ---------------------------------------------------------------------------
// Fixture 06: tracked-as-follows-up
// ---------------------------------------------------------------------------
describe("fixture 06: tracked-as-follows-up", () => {
  it("'Tracked as T60' creates T3 follows_up T60 relation", () => {
    const result = parseSscloud(fixture("06-tracked-as-follows-up.md"));
    const rel = result.relations?.find(
      (r) => r.from === "T3" && r.to === "T60" && r.kind === "follows_up",
    );
    expect(rel).toBeDefined();
  });

  it("T3 has status=done", () => {
    const result = parseSscloud(fixture("06-tracked-as-follows-up.md"));
    expect(result.tickets.find((t) => t.id === "T3")!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Fixture 07: deferred
// ---------------------------------------------------------------------------
describe("fixture 07: deferred", () => {
  it("T46 has status=deferred", () => {
    const result = parseSscloud(fixture("07-deferred.md"));
    expect(result.tickets.find((t) => t.id === "T46")!.status).toBe("deferred");
  });

  it("T46 has P3 priority", () => {
    const result = parseSscloud(fixture("07-deferred.md"));
    expect(result.tickets.find((t) => t.id === "T46")!.priority).toBe("P3");
  });
});

// ---------------------------------------------------------------------------
// Fixture 08: in-progress
// ---------------------------------------------------------------------------
describe("fixture 08: in-progress", () => {
  it("T9 has status=in_progress", () => {
    const result = parseSscloud(fixture("08-in-progress.md"));
    expect(result.tickets.find((t) => t.id === "T9")!.status).toBe("in_progress");
  });
});

// ---------------------------------------------------------------------------
// Fixture 09: ship-date
// ---------------------------------------------------------------------------
describe("fixture 09: ship-date", () => {
  it("T44 has status=done", () => {
    const result = parseSscloud(fixture("09-ship-date.md"));
    expect(result.tickets.find((t) => t.id === "T44")!.status).toBe("done");
  });

  it("T44 closed_at is normalised to 2026-05-15T00:00:00.000Z", () => {
    const result = parseSscloud(fixture("09-ship-date.md"));
    expect(result.tickets.find((t) => t.id === "T44")!.closed_at).toBe(
      "2026-05-15T00:00:00.000Z",
    );
  });
});

// ---------------------------------------------------------------------------
// Fixture 10: done-no-date
// ---------------------------------------------------------------------------
describe("fixture 10: done-no-date", () => {
  it("T2 is done but closed_at is null (no date in status line)", () => {
    const result = parseSscloud(fixture("10-done-no-date.md"));
    const t2 = result.tickets.find((t) => t.id === "T2")!;
    expect(t2.status).toBe("done");
    expect(t2.closed_at ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fixture 11: priority-epic
// ---------------------------------------------------------------------------
describe("fixture 11: priority-epic", () => {
  it("T5 and T6 both get P1 priority", () => {
    const result = parseSscloud(fixture("11-priority-epic.md"));
    expect(result.tickets.find((t) => t.id === "T5")!.priority).toBe("P1");
    expect(result.tickets.find((t) => t.id === "T6")!.priority).toBe("P1");
  });

  it("T5 and T6 both get epic 'Auth + linking'", () => {
    const result = parseSscloud(fixture("11-priority-epic.md"));
    expect(result.tickets.find((t) => t.id === "T5")!.epic).toBe("Auth + linking");
    expect(result.tickets.find((t) => t.id === "T6")!.epic).toBe("Auth + linking");
  });

  it("T6 blockers T2 and T5 produce relations", () => {
    const result = parseSscloud(fixture("11-priority-epic.md"));
    const rels = result.relations?.filter((r) => r.to === "T6" && r.kind === "blocks") ?? [];
    const fromIds = rels.map((r) => r.from).sort();
    expect(fromIds).toContain("T2");
    expect(fromIds).toContain("T5");
  });
});

// ---------------------------------------------------------------------------
// Fixture 12: multiple priorities
// ---------------------------------------------------------------------------
describe("fixture 12: multiple-priorities", () => {
  it("T1 has P0 priority", () => {
    const result = parseSscloud(fixture("12-multiple-priorities.md"));
    expect(result.tickets.find((t) => t.id === "T1")!.priority).toBe("P0");
  });

  it("T17 has P2 priority", () => {
    const result = parseSscloud(fixture("12-multiple-priorities.md"));
    expect(result.tickets.find((t) => t.id === "T17")!.priority).toBe("P2");
  });

  it("T40 has P3 priority", () => {
    const result = parseSscloud(fixture("12-multiple-priorities.md"));
    expect(result.tickets.find((t) => t.id === "T40")!.priority).toBe("P3");
  });

  it("parses 3 tickets from 3 different priority sections", () => {
    const result = parseSscloud(fixture("12-multiple-priorities.md"));
    expect(result.tickets).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Fixture 13: scope-acceptance-description
// ---------------------------------------------------------------------------
describe("fixture 13: scope-acceptance-description", () => {
  it("T30 description contains both Scope and Acceptance labels", () => {
    const result = parseSscloud(fixture("13-scope-acceptance-description.md"));
    const t30 = result.tickets.find((t) => t.id === "T30")!;
    expect(t30.description).toContain("**Scope:**");
    expect(t30.description).toContain("**Acceptance:**");
  });

  it("T30 description contains scope content", () => {
    const result = parseSscloud(fixture("13-scope-acceptance-description.md"));
    expect(result.tickets.find((t) => t.id === "T30")!.description).toContain("Code-only rollback");
  });

  it("T30 description contains acceptance content", () => {
    const result = parseSscloud(fixture("13-scope-acceptance-description.md"));
    expect(result.tickets.find((t) => t.id === "T30")!.description).toContain("happy path");
  });

  it("T30 has P1 priority and 'Rollback' epic", () => {
    const result = parseSscloud(fixture("13-scope-acceptance-description.md"));
    const t30 = result.tickets.find((t) => t.id === "T30")!;
    expect(t30.priority).toBe("P1");
    expect(t30.epic).toBe("Rollback");
  });
});

// ---------------------------------------------------------------------------
// Fixture 14: backtick-title
// ---------------------------------------------------------------------------
describe("fixture 14: backtick-title", () => {
  it("T14 title contains backticks and special chars", () => {
    const result = parseSscloud(fixture("14-backtick-title.md"));
    const t14 = result.tickets.find((t) => t.id === "T14")!;
    expect(t14).toBeDefined();
    expect(t14.title).toContain("`deploy:status`");
  });

  it("T7 title contains backticks", () => {
    const result = parseSscloud(fixture("14-backtick-title.md"));
    const t7 = result.tickets.find((t) => t.id === "T7")!;
    expect(t7.title).toContain("`sscloud stack:list`");
  });
});

// ---------------------------------------------------------------------------
// Fixture 15: blockers-mixed-prose
// ---------------------------------------------------------------------------
describe("fixture 15: blockers-mixed-prose", () => {
  it("T9 extracts only T<n> refs from Blockers with prose", () => {
    const result = parseSscloud(fixture("15-blockers-mixed-prose.md"));
    const rels = result.relations?.filter((r) => r.to === "T9" && r.kind === "blocks") ?? [];
    const fromIds = rels.map((r) => r.from).sort();
    // Should have T8 and T13, not the prose
    expect(fromIds).toContain("T8");
    expect(fromIds).toContain("T13");
    expect(fromIds).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Fixture 16: umbrella-spawned (T103 with T112-T119 follow-ups)
// ---------------------------------------------------------------------------
describe("fixture 16: umbrella-spawned (T103)", () => {
  it("T103 has status=done", () => {
    const result = parseSscloud(fixture("16-umbrella-spawned.md"));
    expect(result.tickets.find((t) => t.id === "T103")!.status).toBe("done");
  });

  it("T103 has P2 priority", () => {
    const result = parseSscloud(fixture("16-umbrella-spawned.md"));
    expect(result.tickets.find((t) => t.id === "T103")!.priority).toBe("P2");
  });

  it("T103 closed_at extracted from 2026-05-26 date", () => {
    const result = parseSscloud(fixture("16-umbrella-spawned.md"));
    expect(result.tickets.find((t) => t.id === "T103")!.closed_at).toBe(
      "2026-05-26T00:00:00.000Z",
    );
  });
});

// ---------------------------------------------------------------------------
// Fixture 17: T112 open no blockers
// ---------------------------------------------------------------------------
describe("fixture 17: T112 open no blockers", () => {
  it("T112 has status=open (Status: Open.)", () => {
    const result = parseSscloud(fixture("17-t112-open-no-blockers.md"));
    expect(result.tickets.find((t) => t.id === "T112")!.status).toBe("open");
  });

  it("T112 has no blocks relations (Blockers: none)", () => {
    const result = parseSscloud(fixture("17-t112-open-no-blockers.md"));
    const rels = result.relations?.filter((r) => r.to === "T112" && r.kind === "blocks") ?? [];
    expect(rels).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fixture 18: T113 shipped with commit refs
// ---------------------------------------------------------------------------
describe("fixture 18: T113 shipped with commit refs", () => {
  it("T113 has status=done", () => {
    const result = parseSscloud(fixture("18-t113-shipped-with-commit.md"));
    expect(result.tickets.find((t) => t.id === "T113")!.status).toBe("done");
  });

  it("T113 closed_at is 2026-05-27T00:00:00.000Z", () => {
    const result = parseSscloud(fixture("18-t113-shipped-with-commit.md"));
    expect(result.tickets.find((t) => t.id === "T113")!.closed_at).toBe(
      "2026-05-27T00:00:00.000Z",
    );
  });

  it("commit refs preserved in description (not a structured field)", () => {
    const result = parseSscloud(fixture("18-t113-shipped-with-commit.md"));
    const t113 = result.tickets.find((t) => t.id === "T113")!;
    expect(t113.description).toContain("aefc6b6");
  });
});

// ---------------------------------------------------------------------------
// Fixture 19: T115 shipped
// ---------------------------------------------------------------------------
describe("fixture 19: T115 shipped", () => {
  it("T115 has status=done", () => {
    const result = parseSscloud(fixture("19-t115-shipped.md"));
    expect(result.tickets.find((t) => t.id === "T115")!.status).toBe("done");
  });

  it("T115 closed_at is 2026-05-27T00:00:00.000Z", () => {
    const result = parseSscloud(fixture("19-t115-shipped.md"));
    expect(result.tickets.find((t) => t.id === "T115")!.closed_at).toBe(
      "2026-05-27T00:00:00.000Z",
    );
  });
});

// ---------------------------------------------------------------------------
// Fixture 20: range-expansion (T112-T115 → T112..T115)
// ---------------------------------------------------------------------------
describe("fixture 20: range-expansion", () => {
  it("T103 has status=done", () => {
    const result = parseSscloud(fixture("20-range-expansion.md"));
    expect(result.tickets.find((t) => t.id === "T103")!.status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Fixture 21: blocked status
// ---------------------------------------------------------------------------
describe("fixture 21: blocked-status", () => {
  it("T12 has status=blocked", () => {
    const result = parseSscloud(fixture("21-blocked-status.md"));
    expect(result.tickets.find((t) => t.id === "T12")!.status).toBe("blocked");
  });

  it("T12 has blockers T10 and T17", () => {
    const result = parseSscloud(fixture("21-blocked-status.md"));
    const rels = result.relations?.filter((r) => r.to === "T12" && r.kind === "blocks") ?? [];
    const fromIds = rels.map((r) => r.from).sort();
    expect(fromIds).toContain("T10");
    expect(fromIds).toContain("T17");
  });
});

// ---------------------------------------------------------------------------
// Fixture 22: no-scope-acceptance
// ---------------------------------------------------------------------------
describe("fixture 22: no-scope-acceptance", () => {
  it("T20 has status=done (Done inline)", () => {
    const result = parseSscloud(fixture("22-no-scope-acceptance.md"));
    expect(result.tickets.find((t) => t.id === "T20")!.status).toBe("done");
  });

  it("T20 description is empty or undefined when no Scope/Acceptance", () => {
    const result = parseSscloud(fixture("22-no-scope-acceptance.md"));
    const desc = result.tickets.find((t) => t.id === "T20")!.description;
    expect(!desc || desc === "").toBe(true);
  });
});
