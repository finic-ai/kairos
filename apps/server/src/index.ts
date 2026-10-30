import { serve } from "@hono/node-server";
import { boot } from "./boot";
import { loadConfig, type Config } from "./platform/config";
import { serveConsole } from "./console";

let config: Config;
try {
  config = loadConfig();
} catch (cause) {
  console.error((cause as Error).message);
  process.exit(1);
}

const inline = config.worker === "inline";
const { app, database, worker, jobs } = await boot(config, { worker: inline ? "loop" : "enqueue" }).catch((cause) => {
  console.error((cause as Error).message);
  process.exit(1);
});
if (config.consoleDir) serveConsole(app, config.consoleDir);

const server = serve({ fetch: app.fetch, port: config.port }, () => {
  const notes = [
    database.embedded ? `embedded Postgres in ${config.database.dataDir}` : "Postgres from DATABASE_URL",
    ...(config.consoleDir ? ["console on the same address"] : []),
    ...(config.supabase ? ["Supabase sign-in on"] : []),
    ...(config.cognito ? ["Cognito sign-in on"] : []),
    ...(config.signup ? [] : ["sign-up by invite only"]),
    ...(worker ? [] : ["webhooks off (set KAIROS_ENCRYPTION_KEY)"]),
    ...(inline ? [] : ["jobs run in a separate worker (pnpm worker)"]),
  ];
  if (inline) jobs?.start();
  console.log(`Kairos API on http://localhost:${config.port} · ${notes.join(" · ")}`);
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await jobs?.stop();
    // The embedded Postgres must stop with the server, or it holds its port and its files.
    await database.close().catch((cause) => console.error(cause));
    process.exit(0);
  });
}
