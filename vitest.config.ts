import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The server tests need a Postgres. This starts one for the run and removes it after.
    globalSetup: ["apps/server/test/helpers/global-setup.ts"],
    hookTimeout: 30_000,
  },
});
