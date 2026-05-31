import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { makeListTool } from "../tools/list.js";
import { makeLinkTool } from "../tools/link.js";
import { makeGetTool } from "../tools/get.js";
import { parseFlags, FlagParseError } from "./flags.js";

// Schemas are static metadata — a never-opened in-memory handle is enough
// to construct the tools and read their inputSchema. No migrations, no I/O.
const db = new Database(":memory:");
const listSchema = makeListTool(db).inputSchema;
const linkSchema = makeLinkTool(db).inputSchema;
const getSchema = makeGetTool(db).inputSchema;

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
});
