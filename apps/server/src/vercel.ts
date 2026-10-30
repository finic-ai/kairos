import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { boot } from "./boot";
import { loadConfig } from "./platform/config";

/**
 * The entry of the Vercel function. `pnpm build:vercel` bundles it to one file and puts the
 * migrations and the templates next to that file. Vercel serves the console itself, as static files.
 */
const beside = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

const config = loadConfig({
  ...process.env,
  // Every request comes through Vercel's proxy.
  KAIROS_TRUST_PROXY: "1",
  KAIROS_MIGRATIONS: beside("drizzle"),
  KAIROS_TEMPLATES: beside("templates"),
});
// A function has no disk to keep, so there is no embedded Postgres here.
if (!config.database.url) throw new Error("DATABASE_URL is not set. On Vercel, Kairos needs a Postgres to connect to.");

// Once for each instance of the function, not once for each request.
const { app } = await boot(config, { worker: config.worker === "separate" ? "enqueue" : "on-request" });

export default getRequestListener(app.fetch);
