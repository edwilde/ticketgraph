import { fileURLToPath } from "node:url";

export type GetClientRoots = () => Promise<string[]>;

export const NO_ROOTS: GetClientRoots = async () => [];

/**
 * Build a GetClientRoots provider that queries the MCP server's listRoots().
 * Converts file:// URIs to fs paths, skips non-file URIs, returns [] on any error.
 */
export function makeClientRootsProvider(server: {
  listRoots: () => Promise<{ roots: Array<{ uri: string; name?: string }> }>;
}): GetClientRoots {
  return async () => {
    try {
      const { roots } = await server.listRoots();
      const paths: string[] = [];
      for (const root of roots) {
        if (!root.uri.startsWith("file://")) continue;
        try {
          paths.push(fileURLToPath(root.uri));
        } catch {
          // skip malformed file URIs
        }
      }
      return paths;
    } catch {
      return [];
    }
  };
}
