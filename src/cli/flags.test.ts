import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { makeListTool } from "../tools/list.js";
import { makeLinkTool } from "../tools/link.js";
import { makeGetTool } from "../tools/get.js";
import { makeAddTool } from "../tools/add.js";
import { makeRelatedTool } from "../tools/related.js";
import { parseFlags, bindPositionals, FlagParseError } from "./flags.js";

// Schemas are static metadata — a never-opened in-memory handle is enough
// to construct the tools and read their inputSchema. No migrations, no I/O.
const db = new Database(":memory:");
const listSchema = makeListTool(db).inputSchema;
const linkSchema = makeLinkTool(db).inputSchema;
const getSchema = makeGetTool(db).inputSchema;
const addSchema = makeAddTool(db).inputSchema;
const relatedSchema = makeRelatedTool(db).inputSchema;

describe("parseFlags — type-driven coercion", () => {
  it("--limit 5 (space form) → number", () => {
    expect(parseFlags(listSchema, ["--limit", "5"]).values).toEqual({ limit: 5 });
  });

  it("--limit=5 (equals form) → number", () => {
    expect(parseFlags(listSchema, ["--limit=5"]).values).toEqual({ limit: 5 });
  });

  it("non-numeric number flag → NaN (left for parseArgs)", () => {
    const values = parseFlags(listSchema, ["--limit", "abc"]).values;
    expect(Number.isNaN(values["limit"])).toBe(true);
  });

  it("--project foo → string", () => {
    expect(parseFlags(linkSchema, ["--project", "foo"]).values).toEqual({ project: "foo" });
  });

  it("--include_description → boolean true, consumes no value", () => {
    const parsed = parseFlags(listSchema, ["--include_description", "list"]);
    expect(parsed.values).toEqual({ include_description: true });
    expect(parsed.positionals).toEqual(["list"]);
  });

  it("--status open (oneOf, once) → scalar string", () => {
    expect(parseFlags(listSchema, ["--status", "open"]).values).toEqual({ status: "open" });
  });

  it("--status outstanding (oneOf, once) → scalar string, not array", () => {
    expect(parseFlags(listSchema, ["--status", "outstanding"]).values).toEqual({
      status: "outstanding",
    });
  });

  it("--status open --status blocked (oneOf, repeated) → array", () => {
    expect(
      parseFlags(listSchema, ["--status", "open", "--status", "blocked"]).values,
    ).toEqual({ status: ["open", "blocked"] });
  });

  it("--ids a (array-typed prop) → always array", () => {
    expect(parseFlags(getSchema, ["--ids", "a"]).values).toEqual({ ids: ["a"] });
  });

  it("--ids a --ids b (array-typed prop) → accumulates", () => {
    expect(parseFlags(getSchema, ["--ids", "a", "--ids", "b"]).values).toEqual({
      ids: ["a", "b"],
    });
  });

  it("--ids T1 T2 T3 (array-typed prop) → consumes the run", () => {
    expect(parseFlags(getSchema, ["--ids", "T1", "T2", "T3"]).values).toEqual({
      ids: ["T1", "T2", "T3"],
    });
  });

  it("--ids T1 T2 --project x → run stops at the next --flag", () => {
    expect(parseFlags(getSchema, ["--ids", "T1", "T2", "--project", "x"]).values).toEqual({
      ids: ["T1", "T2"],
      project: "x",
    });
  });

  it("add --tags a b → tags:[\"a\",\"b\"] (run consumed, not positionals)", () => {
    expect(parseFlags(addSchema, ["--tags", "a", "b"]).values).toEqual({
      tags: ["a", "b"],
    });
  });

  it("related --kinds a b → kinds:[\"a\",\"b\"] (run consumed)", () => {
    expect(parseFlags(relatedSchema, ["--kinds", "a", "b"]).values).toEqual({
      kinds: ["a", "b"],
    });
  });

  it("bare positional goes into positionals[]", () => {
    expect(parseFlags(getSchema, ["T22"]).positionals).toEqual(["T22"]);
  });

  it("unknown flag → FlagParseError", () => {
    expect(() => parseFlags(listSchema, ["--bogus", "x"])).toThrow(FlagParseError);
  });

  it("value-flag missing its value → FlagParseError", () => {
    expect(() => parseFlags(listSchema, ["--limit"])).toThrow(FlagParseError);
  });

  it("--key=value with a leading-dash value (equals form) is preserved", () => {
    expect(parseFlags(linkSchema, ["--project=--weird"]).values).toEqual({
      project: "--weird",
    });
  });

  it("repeated --id (plain scalar) throws a clear error", () => {
    expect(() => parseFlags(getSchema, ["--id", "T1", "--id", "T2"])).toThrow(
      FlagParseError,
    );
    expect(() => parseFlags(getSchema, ["--id", "T1", "--id", "T2"])).toThrow(/--id/);
  });

  it("repeated --status still folds scalar→array (oneOf unaffected)", () => {
    expect(
      parseFlags(listSchema, ["--status", "open", "--status", "blocked"]).values,
    ).toEqual({ status: ["open", "blocked"] });
  });

  // Order constraint: positional BEFORE a variadic array flag works correctly.
  it("related T5 --kinds blocks depends (positional first) → id:T5, kinds:[blocks,depends]", () => {
    const parsed = parseFlags(relatedSchema, ["T5", "--kinds", "blocks", "depends"]);
    expect(parsed.values).toEqual({ kinds: ["blocks", "depends"] });
    expect(parsed.positionals).toEqual(["T5"]);
  });

  // Order constraint: positional AFTER a variadic array flag is consumed into the array.
  // This documents the order-sensitivity trap — the test pins the actual behaviour so
  // a future refactor can't silently break or unbreak it without notice.
  it("related --kinds blocks T5 (positional after array flag) → T5 absorbed into kinds, no positional", () => {
    const parsed = parseFlags(relatedSchema, ["--kinds", "blocks", "T5"]);
    expect(parsed.values).toEqual({ kinds: ["blocks", "T5"] });
    expect(parsed.positionals).toEqual([]);
  });
});

describe("bindPositionals — multi-positional get", () => {
  it("get with 2+ positionals → binds the full array to ids", () => {
    expect(bindPositionals("get", ["T1", "T2", "T3"], {})).toEqual({
      ids: ["T1", "T2", "T3"],
    });
  });

  it("get with a single positional → still binds to id (not ids)", () => {
    expect(bindPositionals("get", ["T1"], {})).toEqual({ id: "T1" });
  });

  it("related with 2+ positionals → still throws (no ids param)", () => {
    expect(() => bindPositionals("related", ["T1", "T2"], {})).toThrow(FlagParseError);
  });
});
