import { describe, it, expect } from "vitest";
import { NO_ROOTS, makeClientRootsProvider } from "./roots.js";

describe("NO_ROOTS", () => {
  it("returns an empty array", async () => {
    const result = await NO_ROOTS();
    expect(result).toEqual([]);
  });
});

describe("makeClientRootsProvider", () => {
  it("converts file:// uris to fs paths", async () => {
    const server = {
      listRoots: async () => ({
        roots: [
          { uri: "file:///home/user/project" },
          { uri: "file:///tmp/other" },
        ],
      }),
    };
    const provider = makeClientRootsProvider(server);
    const result = await provider();
    expect(result).toEqual(["/home/user/project", "/tmp/other"]);
  });

  it("skips non-file uris", async () => {
    const server = {
      listRoots: async () => ({
        roots: [
          { uri: "file:///home/user/project" },
          { uri: "https://example.com/repo" },
          { uri: "git://github.com/foo/bar" },
        ],
      }),
    };
    const provider = makeClientRootsProvider(server);
    const result = await provider();
    expect(result).toEqual(["/home/user/project"]);
  });

  it("returns [] when listRoots rejects", async () => {
    const server = {
      listRoots: async () => {
        throw new Error("Client does not support roots capability");
      },
    };
    const provider = makeClientRootsProvider(server);
    const result = await provider();
    expect(result).toEqual([]);
  });

  it("returns [] when roots array is empty", async () => {
    const server = {
      listRoots: async () => ({ roots: [] }),
    };
    const provider = makeClientRootsProvider(server);
    const result = await provider();
    expect(result).toEqual([]);
  });

  it("skips uris only if all are non-file", async () => {
    const server = {
      listRoots: async () => ({
        roots: [{ uri: "vscode://extension/foo" }],
      }),
    };
    const provider = makeClientRootsProvider(server);
    const result = await provider();
    expect(result).toEqual([]);
  });
});
