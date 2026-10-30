import { boot } from "./boot";
import { loadConfig, type Config } from "./platform/config";

/**
 * The worker process: it runs the background jobs (webhook deliveries, automatic decisions,
 * cleanup) and serves no HTTP. Start it next to API servers that have KAIROS_WORKER=separate.
 * Any number of workers can run on one database: each job is claimed by one of them.
 */

let config: Config;
try {
  config = loadConfig();
} catch (cause) {
  console.error((cause as Error).message);
  process.exit(1);
}

const { database, worker, jobs } = await boot(config, { worker: "loop" }).catch((cause) => {
  console.error((cause as Error).message);
  process.exit(1);
});

const notes = [
  database.embedded ? `embedded Postgres in ${config.database.dataDir}` : "Postgres from DATABASE_URL",
  ...(worker ? [] : ["webhooks off (set KAIROS_ENCRYPTION_KEY)"]),
  ...(config.worker === "inline" ? ["KAIROS_WORKER is not separate, so the API runs jobs too"] : []),
];
jobs!.start();
// The tick of the jobs does not hold the process open (in the API, the server does), so this does.
const alive = setInterval(() => {}, 60_000);
console.log(`Kairos worker · ${notes.join(" · ")}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(alive);
    // The rest stay in the table for the next worker.
    await jobs!.stop();
    await database.close().catch((cause) => console.error(cause));
    process.exit(0);
  });
}
