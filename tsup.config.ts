import { defineConfig } from "tsup";
import { cpSync } from "node:fs";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  outDir: "dist",
  target: "node20",
  sourcemap: true,
  minify: false,
  clean: true,
  shims: false,
  splitting: false,
  external: ["better-sqlite3", "@modelcontextprotocol/sdk"],
  banner: {
    js: "#!/usr/bin/env node",
  },
  onSuccess: async () => {
    cpSync("src/migrations", "dist/migrations", { recursive: true });
  },
});
