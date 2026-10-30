import { defineConfig } from "drizzle-kit";

// Migrations are generated from the schema: `pnpm --filter @kairos/server db:generate`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
});
