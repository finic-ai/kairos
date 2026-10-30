import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import type { Env } from "./platform/http";

/**
 * Serve the built console from the same address as the API, so that one process is the whole
 * product and the session cookie needs no CORS. The console keeps its place in the URL hash,
 * so every page of it is index.html. The documentation is static pages under /docs.
 */
export function serveConsole(app: Hono<Env>, dir: string): void {
  // Vite puts a hash of the content in the name of every file in assets/, so they never change.
  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
  });
  // Each page of the documentation is also published as its markdown, for agents and for "Copy page".
  app.use("/docs/*", async (c, next) => {
    await next();
    if (c.res.ok && c.req.path.endsWith(".md")) c.header("Content-Type", "text/markdown; charset=utf-8");
  });
  app.use("*", serveStatic({ root: dir }));
}
