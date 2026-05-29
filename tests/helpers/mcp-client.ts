import type { ChildProcess } from "node:child_process";

let _nextId = 1;

function nextId(): number {
  return _nextId++;
}

/**
 * Resolve once the spawned server has logged its startup line on stderr,
 * i.e. migrations applied + transport about to connect. Sending `initialize`
 * before this point is a race: under heavy parallel test load the server's
 * cold start (node boot + better-sqlite3 native load + migrations) can lag,
 * and the request would reject before the transport is reading. Waiting for
 * the readiness line removes the race deterministically.
 */
export function waitForServerReady(child: ChildProcess, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Server did not log startup within timeout. stderr:\n" + buf));
    }, timeoutMs);

    function onStderr(chunk: Buffer | string): void {
      buf += chunk.toString();
      if (buf.includes("ticketgraph starting")) {
        cleanup();
        resolve();
      }
    }
    function onClose(code: number | null): void {
      cleanup();
      reject(new Error(`Server closed (code=${code}) before becoming ready. stderr:\n${buf}`));
    }
    function cleanup(): void {
      clearTimeout(timer);
      child.stderr?.off("data", onStderr);
      child.off("close", onClose);
    }

    child.stderr?.on("data", onStderr);
    child.on("close", onClose);
  });
}

/**
 * Send a JSON-RPC 2.0 request to the child's stdin and wait for the matching
 * response on stdout. Times out after 5 s to fail fast on hangs.
 *
 * **Contract:** caller must `await` each call before issuing the next one.
 * Each invocation attaches a fresh `data` listener with a fresh line buffer,
 * so concurrent calls would partition the stdout stream across listeners and
 * drop frames at chunk boundaries. If T5+ tests ever need pipelined or
 * notification-driven traffic, refactor into a persistent client object that
 * owns a single stdout listener and a pending-by-id map.
 */
export function sendRequest(
  child: ChildProcess,
  method: string,
  params?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for response to ${method} (id=${id})`));
    }, 15000);

    let buffer = "";

    function onData(chunk: Buffer | string): void {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      // Keep the last (potentially incomplete) fragment
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          // Not JSON — ignore (could be a non-JSON framing line)
          continue;
        }
        if (
          typeof msg === "object" &&
          msg !== null &&
          "id" in msg &&
          (msg as Record<string, unknown>)["id"] === id
        ) {
          cleanup();
          resolve(msg);
          return;
        }
      }
    }

    function onClose(): void {
      cleanup();
      reject(new Error(`Child process closed before responding to ${method} (id=${id})`));
    }

    function cleanup(): void {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("close", onClose);
    }

    child.stdout?.on("data", onData);
    child.on("close", onClose);

    child.stdin?.write(request);
  });
}
