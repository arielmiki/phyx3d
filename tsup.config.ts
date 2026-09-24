import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/node/cli.ts", mcp: "src/node/mcp.ts", index: "src/core/index.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  clean: false,
  splitting: true,
});
