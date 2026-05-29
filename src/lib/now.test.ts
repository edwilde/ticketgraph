import { describe, it, expect } from "vitest";
import { nowIso } from "./now.js";

describe("nowIso", () => {
  it("returns a UTC ISO 8601 string with millisecond precision", () => {
    const ts = nowIso();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("is close to the current time (within 1 second)", () => {
    const before = Date.now();
    const ts = nowIso();
    const after = Date.now();
    const parsed = new Date(ts).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after + 1);
  });
});
