/**
 * Bootstrap integration test.
 *
 * Spawns the BUILT artifact with TICKETGRAPH_DB_PATH pointing at a temp file,
 * waits for the startup log, signals SIGTERM, then opens the resulting DB and
 * asserts user_version = 1. Covers the out-of-process bootstrap chain:
 * spawn → openDb → migrations → log → ready.
 *
 * Assumes dist/server.js is already built (server.stdio.test.ts runs the
 * build in beforeAll; run `npm run build` manually if running this file alone).
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVER = resolve(ROOT, "dist/server.js");

describe("server bootstrap with migrations", () => {
  it("creates the DB file with user_version=1 on first start", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ticketgraph-bootstrap-"));
    const dbPath = join(tmpDir, "test.db");

    try {
      await new Promise<void>((resolveP, rejectP) => {
        const child = spawn("node", [SERVER], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: ROOT,
          env: { ...process.env, TICKETGRAPH_DB_PATH: dbPath },
        });

        // Generous startup wait: under heavy parallel load the cold start
        // (node boot + better-sqlite3 native load + migrations) can lag well
        // past 5 s though nothing is wrong. 10 s sits under the 15 s it-timeout.
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          rejectP(new Error("Server did not log 'ticketgraph starting' within 10 s"));
        }, 10000);

        let buf = "";
        const onStderr = (chunk: Buffer): void => {
          buf += chunk.toString();
          if (buf.includes("ticketgraph starting")) {
            child.stderr?.off("data", onStderr);
            clearTimeout(timeout);
            child.kill("SIGTERM");
          }
        };
        child.stderr?.on("data", onStderr);

        child.on("close", (code) => {
          if (code === 0) {
            resolveP();
          } else {
            rejectP(new Error(`Server exited with code ${String(code)}`));
          }
        });
      });

      // Server has shut down cleanly — open the DB file and assert schema version.
      const db = new Database(dbPath, { readonly: true });
      const version = db.pragma("user_version", { simple: true }) as number;
      db.close();

      expect(version).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);
});
