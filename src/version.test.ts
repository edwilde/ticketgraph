import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { getPackageVersion } from "./version.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("getPackageVersion", () => {
  it("returns the version from package.json", () => {
    const raw = readFileSync(resolve(__dirname, "../package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { version: string };
    expect(getPackageVersion()).toBe(pkg.version);
  });

  it("returns the same string on repeated calls (cached)", () => {
    const v1 = getPackageVersion();
    const v2 = getPackageVersion();
    expect(v1).toBe(v2);
    expect(v1).toMatch(/^\d+\.\d+\.\d+/);
  });
});
