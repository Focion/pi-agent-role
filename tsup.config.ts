import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  outDir: "dist",
  outExtension: ({ format }) => ({ js: format === "esm" ? ".js" : ".cjs" }),
  splitting: false,
  treeshake: true,
});