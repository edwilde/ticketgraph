/**
 * vitest globalSetup — runs once before all test files.
 * Builds dist/server.js so integration tests can spawn the real artifact.
 */
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

export function setup(): void {
  execSync("npm run build", { cwd: ROOT, stdio: "pipe" });
}
