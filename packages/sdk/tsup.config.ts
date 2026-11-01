import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/middleware.ts", "src/browser.ts", "src/routes.ts"],
  format: ["esm"],
  target: "es2022",
  noExternal: ["@finic-ai/kairosid"],
  sourcemap: true,
  clean: true,
});
