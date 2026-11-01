import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Plugin } from "vite";

const entry = fileURLToPath(new URL("../../../packages/sdk/src/script.ts", import.meta.url));

const bundle = async () => {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    target: "es2019",
    minify: true,
    write: false,
  });
  return result.outputFiles[0]!.text;
};

/**
 * The website script, at /kairos.js of the server: the snippet loads it from there, and the
 * client sends to the address it came from.
 */
export function script(): Plugin {
  return {
    name: "kairos-script",
    configureServer(server) {
      server.middlewares.use("/kairos.js", (_req, res, next) => {
        bundle().then((text) => {
          res.setHeader("Content-Type", "text/javascript; charset=utf-8");
          res.end(text);
        }, next);
      });
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: "kairos.js", source: await bundle() });
    },
  };
}
