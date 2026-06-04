import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { makeGetTool } from "../tools/get.js";
import { makeListTool } from "../tools/list.js";
import { makeAddManyTool } from "../tools/add_many.js";
import { makeRelatedTool } from "../tools/related.js";
import { resolveRawArgs } from "./input.js";
import { FlagParseError } from "./flags.js";

const db = new Database(":memory:");
const getTool = makeGetTool(db);
const listTool = makeListTool(db);
const addManyTool = makeAddManyTool(db);
const relatedTool = makeRelatedTool(db);

describe("resolveRawArgs — --json escape hatch", () => {
  it("uses the --json string verbatim as the full args object", async () => {
    const raw = await resolveRawArgs(addManyTool, "add_many", [
      "--json",
      '{"tickets":[{"title":"x"}]}',
    ]);
    expect(raw).toEqual({ tickets: [{ title: "x" }] });
  });

  it("--json content is the full args object, not a bare array", async () => {
    const raw = await resolveRawArgs(listTool, "list", ["--json", '{"status":"open"}']);
    expect(raw).toEqual({ status: "open" });
  });

  it("--json - reads JSON from the injected stdin stream", async () => {
    const stdin = Readable.from(['{"tickets":', '[{"title":"y"}]}']);
    const raw = await resolveRawArgs(addManyTool, "add_many", ["--json", "-"], { stdin });
    expect(raw).toEqual({ tickets: [{ title: "y" }] });
  });

  it("--json=<value> (equals form) parses to the object", async () => {
    const raw = await resolveRawArgs(addManyTool, "add_many", [
      '--json={"tickets":[{"title":"x"}]}',
    ]);
    expect(raw).toEqual({ tickets: [{ title: "x" }] });
  });

  it("--json=- (equals form) reads JSON from the injected stdin stream", async () => {
    const stdin = Readable.from(['{"tickets":[{"title":"z"}]}']);
    const raw = await resolveRawArgs(addManyTool, "add_many", ["--json=-"], { stdin });
    expect(raw).toEqual({ tickets: [{ title: "z" }] });
  });

  it("--json={…} --project x (equals form) is still a structural exclusivity error", async () => {
    await expect(
      resolveRawArgs(listTool, "list", ['--json={"status":"open"}', "--project", "x"]),
    ).rejects.toThrow(FlagParseError);
  });

  it("invalid JSON in --json → FlagParseError", async () => {
    await expect(
      resolveRawArgs(listTool, "list", ["--json", "{not json"]),
    ).rejects.toThrow(FlagParseError);
  });

  it("--json combined with another flag → FlagParseError", async () => {
    await expect(
      resolveRawArgs(listTool, "list", ["--json", "{}", "--project", "x"]),
    ).rejects.toThrow(FlagParseError);
  });

  it("--json combined with a positional → FlagParseError", async () => {
    await expect(
      resolveRawArgs(getTool, "get", ["--json", "{}", "T22"]),
    ).rejects.toThrow(FlagParseError);
  });
});

describe("resolveRawArgs — positional binding", () => {
  it("get T22 → { id: 'T22' }", async () => {
    expect(await resolveRawArgs(getTool, "get", ["T22"])).toEqual({ id: "T22" });
  });

  it("merges a positional with flags", async () => {
    expect(await resolveRawArgs(getTool, "get", ["T22", "--project", "p"])).toEqual({
      id: "T22",
      project: "p",
    });
  });

  it("two positionals for a single-positional command → FlagParseError", async () => {
    await expect(resolveRawArgs(relatedTool, "related", ["T1", "T2"])).rejects.toThrow(
      FlagParseError,
    );
  });

  it("multiple positionals for get → folds into ids", async () => {
    expect(await resolveRawArgs(getTool, "get", ["T1", "T2", "T3"])).toEqual({
      ids: ["T1", "T2", "T3"],
    });
  });

  it("positional for an unmapped command → FlagParseError", async () => {
    await expect(resolveRawArgs(listTool, "list", ["T22"])).rejects.toThrow(
      FlagParseError,
    );
  });

  it("plain flags with no positional", async () => {
    expect(await resolveRawArgs(listTool, "list", ["--limit", "5"])).toEqual({
      limit: 5,
    });
  });
});

describe("resolveRawArgs — add_many flag guard", () => {
  it("add_many with flags (no --json) → explicit hatch error", async () => {
    await expect(
      resolveRawArgs(addManyTool, "add_many", ["--project", "p"]),
    ).rejects.toThrow(/add_many requires --json/);
  });
});
