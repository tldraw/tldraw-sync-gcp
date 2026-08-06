import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each file imports the room manager singleton, which opens Redis clients
    // and registers subscriptions at module load; separate processes keep that
    // module state from leaking between files.
    pool: "forks",
    restoreMocks: true,
  },
})
