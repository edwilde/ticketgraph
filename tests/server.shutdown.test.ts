/**
 * Graceful shutdown regression tests.
 *
 * Verifies that the server exits with code 0 within 1 second of receiving
 * SIGTERM or SIGINT. Guards against the common bug where SIGINT is never
 * bound and the server ignores Ctrl-C.
 *
 * The build is assumed to have been produced already (server.stdio.test.ts
 * runs beforeAll npm run build). If running this file in isolation, build
 * manually first: npm run build.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVER = resolve(ROOT, "dist/server.js");

function waitForExit(signal: NodeJS.Signals): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // Isolated temp DB — never touch the live ~/.claude/tickets.db (spec §16).
    const dbDir = mkdtempSync(join(tmpdir(), "ticketgraph-shutdown-"));
    const child = spawn("node", [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ROOT,
      env: { ...process.env, TICKETGRAPH_DB_PATH: join(dbDir, "test.db") },
    });
    const cleanupDb = (): void => rmSync(dbDir, { recursive: true, force: true });

    // Wait for the explicit startup log line before signalling — guarantees
    // the SIG handlers are registered.
    let buf = "";
    const onStderr = (chunk: Buffer): void => {
      buf += chunk.toString();
      if (buf.includes("ticketgraph starting")) {
        child.stderr?.off("data", onStderr);
        child.kill(signal);
      }
    };
    child.stderr?.on("data", onStderr);

    // The bound exists to catch a server that IGNORES the signal or hangs in
    // shutdown — NOT to benchmark exit latency. Under heavy parallel test load
    // (40+ files competing for CPU) a working server's signal handler can be
    // scheduled several seconds late. Keep this generous and just under the
    // vitest it-timeout (15 s): 12 s still flags a genuinely hung server while
    // tolerating loaded-machine scheduling. (A tighter bound flaked at 1 s and 4 s.)
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      cleanupDb();
      reject(new Error(`Server did not exit within 12 s after ${signal}`));
    }, 12000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      cleanupDb();
      resolve(code);
    });
  });
}

describe("graceful shutdown", () => {
  it("exits with code 0 on SIGTERM", async () => {
    const code = await waitForExit("SIGTERM");
    expect(code).toBe(0);
  }, 15000);

  it("exits with code 0 on SIGINT", async () => {
    const code = await waitForExit("SIGINT");
    expect(code).toBe(0);
  }, 15000);
});
