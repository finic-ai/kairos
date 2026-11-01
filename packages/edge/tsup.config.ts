import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cloudflare.ts"],
  format: ["esm"],
  target: "es2022",
  sourcemap: true,
  clean: true,
});
