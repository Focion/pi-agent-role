import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // better-sqlite3 is native; run each test file in its own process for isolation
    pool: "forks",
    fileParallelism: true,
    // pi SDK dlopens a clipboard native module that hangs in this environment;
    // TERMUX_VERSION=1 makes pi skip it (checked before any pi import)
    env: { TERMUX_VERSION: "1" },
  },
});