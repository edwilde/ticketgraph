import { describe, it, expect } from "vitest";
import { validateImportFile } from "./import-format.js";

describe("validateImportFile", () => {
  it("accepts a minimal valid file", () => {
    const result = validateImportFile({
      project_id: "demo",
      tickets: [{ id: "T1", title: "First task" }],
    });
    expect(result.project_id).toBe("demo");
    expect(result.tickets).toHaveLength(1);
    expect(result.tickets[0]!.id).toBe("T1");
  });

  it("accepts a full valid file with relations", () => {
    const result = validateImportFile({
      project_id: "demo",
      tickets: [
        {
          id: "T1",
          title: "Task one",
          description: "desc",
          status: "done",
          priority: "P1",
          type: "task",
          effort: 3,
          epic: "Foundation",
          parent_id: null,
          created_by: "migrated:demo",
          created_at: "2026-01-01T00:00:00.000Z",
          closed_at: "2026-01-02T00:00:00.000Z",
          tags: ["alpha", "beta"],
        },
        {
          id: "T2",
          title: "Task two",
          priority: null,
          effort: null,
        },
      ],
      relations: [{ from: "T1", to: "T2", kind: "blocks", note: "T2 waits on T1" }],
    });
    expect(result.tickets).toHaveLength(2);
    expect(result.relations).toHaveLength(1);
    expect(result.relations![0]!.kind).toBe("blocks");
  });

  it("throws when project_id is missing", () => {
    expect(() =>
      validateImportFile({ tickets: [] }),
    ).toThrow("project_id");
  });

  it("throws when project_id is empty string", () => {
    expect(() =>
      validateImportFile({ project_id: "  ", tickets: [] }),
    ).toThrow("project_id");
  });

  it("throws when tickets is not an array", () => {
    expect(() =>
      validateImportFile({ project_id: "x", tickets: "bad" }),
    ).toThrow("tickets must be an array");
  });

  it("throws when a ticket is missing id", () => {
    expect(() =>
      validateImportFile({ project_id: "x", tickets: [{ title: "No id" }] }),
    ).toThrow("tickets[0].id");
  });

  it("throws when a ticket is missing title", () => {
    expect(() =>
      validateImportFile({ project_id: "x", tickets: [{ id: "T1" }] }),
    ).toThrow("tickets[0].title");
  });

  it("throws on bad effort value", () => {
    expect(() =>
      validateImportFile({
        project_id: "x",
        tickets: [{ id: "T1", title: "X", effort: 4 }],
      }),
    ).toThrow("effort");
  });

  it("throws on bad status value", () => {
    expect(() =>
      validateImportFile({
        project_id: "x",
        tickets: [{ id: "T1", title: "X", status: "nope" }],
      }),
    ).toThrow("status");
  });

  it("throws on bad type value", () => {
    expect(() =>
      validateImportFile({
        project_id: "x",
        tickets: [{ id: "T1", title: "X", type: "invalid" }],
      }),
    ).toThrow("type");
  });

  it("throws on bad priority value", () => {
    expect(() =>
      validateImportFile({
        project_id: "x",
        tickets: [{ id: "T1", title: "X", priority: "P9" }],
      }),
    ).toThrow("priority");
  });

  it("allows priority null", () => {
    const result = validateImportFile({
      project_id: "x",
      tickets: [{ id: "T1", title: "X", priority: null }],
    });
    expect(result.tickets[0]!.priority).toBeNull();
  });

  it("throws on invalid created_at format", () => {
    expect(() =>
      validateImportFile({
        project_id: "x",
        tickets: [{ id: "T1", title: "X", created_at: "2026-01-01" }],
      }),
    ).toThrow("created_at");
  });

  it("allows ISO 8601 created_at", () => {
    const result = validateImportFile({
      project_id: "x",
      tickets: [{ id: "T1", title: "X", created_at: "2026-01-01T00:00:00.000Z" }],
    });
    expect(result.tickets[0]!.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("throws on bad relation kind", () => {
    expect(() =>
      validateImportFile({
        project_id: "x",
        tickets: [{ id: "T1", title: "X" }],
        relations: [{ from: "T1", to: "T2", kind: "owns" }],
      }),
    ).toThrow("kind");
  });

  it("throws when relations is not an array", () => {
    expect(() =>
      validateImportFile({
        project_id: "x",
        tickets: [],
        relations: "bad",
      }),
    ).toThrow("relations must be an array");
  });

  it("accepts all valid relation kinds", () => {
    const kinds = ["blocks", "follows_up", "supersedes", "relates_to"];
    for (const kind of kinds) {
      const result = validateImportFile({
        project_id: "x",
        tickets: [{ id: "T1", title: "T1" }, { id: "T2", title: "T2" }],
        relations: [{ from: "T1", to: "T2", kind }],
      });
      expect(result.relations![0]!.kind).toBe(kind);
    }
  });

  it("accepts all valid effort values", () => {
    for (const effort of [1, 2, 3, 5, 8, 13]) {
      const result = validateImportFile({
        project_id: "x",
        tickets: [{ id: "T1", title: "X", effort }],
      });
      expect(result.tickets[0]!.effort).toBe(effort);
    }
  });

  it("accepts tags array", () => {
    const result = validateImportFile({
      project_id: "x",
      tickets: [{ id: "T1", title: "X", tags: ["alpha", "beta"] }],
    });
    expect(result.tickets[0]!.tags).toEqual(["alpha", "beta"]);
  });

  it("throws when tags contains a non-string", () => {
    expect(() =>
      validateImportFile({
        project_id: "x",
        tickets: [{ id: "T1", title: "X", tags: [1, 2] }],
      }),
    ).toThrow("tags");
  });

  it("throws when raw is not an object", () => {
    expect(() => validateImportFile(42)).toThrow("JSON object");
    expect(() => validateImportFile(null)).toThrow("JSON object");
    expect(() => validateImportFile([])).toThrow("JSON object");
  });
});
