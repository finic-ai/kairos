import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cloudflare.ts", "src/fastly.ts", "src/lambda.ts"],
  format: ["esm"],
  target: "es2022",
  external: [/^fastly:/],
  sourcemap: true,
  clean: true,
});
