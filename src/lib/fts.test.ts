import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../db.js";
import { sanitiseFtsQuery } from "./fts.js";

// ---------------------------------------------------------------------------
// Pure unit tests — no DB needed
// ---------------------------------------------------------------------------

describe("sanitiseFtsQuery", () => {
  it("two tokens → quoted pair joined by space", () => {
    expect(sanitiseFtsQuery("foo bar")).toBe('"foo" "bar"');
  });

  it("single token → single quoted term", () => {
    expect(sanitiseFtsQuery("hello")).toBe('"hello"');
  });

  it("embedded double-quote is doubled and wrapped", () => {
    // 'a "b' → "a" """b"
    expect(sanitiseFtsQuery('a "b')).toBe('"a" """b"');
  });

  it("FTS5 operator : survives as a literal character", () => {
    const result = sanitiseFtsQuery("foo:bar");
    expect(result).toBe('"foo:bar"');
  });

  it("FTS5 operator ( survives as a literal character", () => {
    const result = sanitiseFtsQuery("wes(");
    expect(result).toBe('"wes("');
  });

  it("FTS5 operator * survives as a literal character", () => {
    const result = sanitiseFtsQuery("foo*");
    expect(result).toBe('"foo*"');
  });

  it("FTS5 operator - survives as a literal character", () => {
    const result = sanitiseFtsQuery("-foo");
    expect(result).toBe('"-foo"');
  });

  it("multi-character operator string (foo:bar () survives)", () => {
    const result = sanitiseFtsQuery("foo:bar (");
    expect(result).toBe('"foo:bar" "("');
  });

  it("empty string → empty string", () => {
    expect(sanitiseFtsQuery("")).toBe("");
  });

  it("whitespace-only → empty string", () => {
    expect(sanitiseFtsQuery("   ")).toBe("");
  });

  it("multiple spaces between tokens → single space in output", () => {
    expect(sanitiseFtsQuery("a  b")).toBe('"a" "b"');
  });
});

// ---------------------------------------------------------------------------
// Integration: prove the sanitised output executes without FTS5 syntax error
// ---------------------------------------------------------------------------

describe("sanitiseFtsQuery — real MATCH execution", () => {
  const tmpDirs: string[] = [];

  function makeTmpDb() {
    const dir = mkdtempSync(join(tmpdir(), "ticketgraph-fts-test-"));
    tmpDirs.push(dir);
    const { db } = openDb({ path: join(dir, "test.db") });
    db.prepare(
      "INSERT INTO projects (id, display_name, root_path, created_at) VALUES (?, ?, ?, ?)",
    ).run("p1", "P1", dir, "2026-01-01T00:00:00.000Z");
    return db;
  }

  it("operator query 'foo:bar (' executes without syntax error", () => {
    const db = makeTmpDb();
    const matchExpr = sanitiseFtsQuery("foo:bar (");
    expect(() => {
      db.prepare("SELECT * FROM tickets_fts WHERE tickets_fts MATCH ?").all(matchExpr);
    }).not.toThrow();
    while (tmpDirs.length > 0) {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("dash-prefixed query '-foo' executes without syntax error", () => {
    const db = makeTmpDb();
    const matchExpr = sanitiseFtsQuery("-foo");
    expect(() => {
      db.prepare("SELECT * FROM tickets_fts WHERE tickets_fts MATCH ?").all(matchExpr);
    }).not.toThrow();
    while (tmpDirs.length > 0) {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });
});
