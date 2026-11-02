import { createGraysonClient } from "@kairos/core";
import { createApp } from "./app";
import type { Config } from "./platform/config";
import { migrate, openDatabase, pendingMigrations } from "./platform/database";
import { tenancyRepository, createRepositories, environmentsRepository } from "./repositories";
import { createBackground, type WorkerMode } from "./modules/jobs";
import { loadPresets } from "./modules/webhooks/libs";
import { loadTemplates } from "./modules/actions/service";
import { loadEntityTemplates } from "./modules/catalog/service";
import { loadViewTemplates } from "./modules/cases/service";
import { loadRulesetTemplates } from "./modules/rulesets";

export type { WorkerMode } from "./modules/jobs";

export async function boot(config: Config, { worker }: { worker?: WorkerMode } = {}) {
  const database = await openDatabase(config.database);
  if (config.migrateOnStart) {
    await migrate(database.db, config.migrationsDir);
  } else {
    // Migrations are a step of the deployment (see README, Deployment). A server on a database
    // that is behind would fail on the first query that needs the new schema, so it does not start.
    const pending = await pendingMigrations(database.db, config.migrationsDir);
    if (pending.length) {
      await database.close();
      throw new Error(
        `The database is ${pending.length === 1 ? "1 migration" : `${pending.length} migrations`} behind (${pending.join(", ")}). Run the migrate step (\`pnpm db:migrate\`, or \`node migrate.mjs\` in a built server), then start the server again. See docs/deployment/self-hosting.md.`,
      );
    }
  }

  const repos = createRepositories(database.db);
  const decider = createGraysonClient({ apiKey: config.graysonApiKey, timeoutMs: 10_000, maxRetries: 2 });
  const now = () => new Date();
  const { jobs, webhooks, automatic } = createBackground({
    db: database.db,
    repos,
    decider,
    now,
    webhooks: config.webhooks,
    worker,
  });

  const app = createApp({
    repos,
    accounts: tenancyRepository(database.db),
    environments: environmentsRepository(database.db),
    decider,
    automatic,
    jobs,
    signup: config.signup,
    supabase: config.supabase,
    cognito: config.cognito,
    trustProxy: config.trustProxy,
    templates: loadTemplates(config.templatesDir),
    entityTemplates: loadEntityTemplates(config.templatesDir),
    viewTemplates: loadViewTemplates(config.templatesDir),
    rulesetTemplates: loadRulesetTemplates(config.templatesDir),
    presets: loadPresets(config.templatesDir),
    webhooks,
  });

  return { app, database, worker: webhooks.worker, jobs, automatic };
}
