import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const _version: string = (() => {
  const raw = readFileSync(resolve(__dirname, "../package.json"), "utf-8");
  const pkg = JSON.parse(raw) as unknown;
  if (
    typeof pkg !== "object" ||
    pkg === null ||
    typeof (pkg as Record<string, unknown>)["version"] !== "string"
  ) {
    throw new Error("package.json missing version");
  }
  return (pkg as Record<string, unknown>)["version"] as string;
})();

export function getPackageVersion(): string {
  return _version;
}
