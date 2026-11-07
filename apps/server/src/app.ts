import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppOptions } from "./context";
import { error, limitBody, type Env } from "./platform/http";
import { ipOf } from "./platform/network";
import { rateLimit } from "./platform/rate-limit";
import { AppError, ERROR_STATUS } from "./platform/error";
import { catalogModule } from "./modules/catalog";
import { actionsModule } from "./modules/actions";
import { decisionsModule } from "./modules/decisions";
import { environmentsModule } from "./modules/environments";
import { createEnvironments } from "./modules/environments/service";
import { webhooksModule } from "./modules/webhooks";
import { authModule } from "./modules/auth";
import { ingestModule } from "./modules/ingest";
import { observeModule } from "./modules/observe";
import { jobsModule } from "./modules/jobs";
import { workflowsModule } from "./modules/workflows";
import { casesModule } from "./modules/cases";
import { mcpModule } from "./modules/mcp";
import { modelsModule } from "./modules/models";
import { rulesetsModule } from "./modules/rulesets";
import { listsModule } from "./modules/lists";
import { experimentsModule } from "./modules/experiments";
import { tenancyModule } from "./modules/tenancy";
import { apiAuth } from "./platform/auth";
import { activityLog } from "./platform/activity";
import { activitiesModule } from "./modules/activities";
import { clientsModule } from "./modules/clients";
import { cloudflareModule } from "./modules/cloudflare";
import { internalRoutes } from "./internal";
import { LIMITS, RateLimitsService } from "./services/rate_limit.service";
import { SessionsService } from "./services/session.service";
import { UsersService } from "./services/user.service";
import { WorkspacesService } from "./services/workspace.service";

export type { AppOptions } from "./context";

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_PUBLIC_BYTES = 2 * 1024 * 1024;

export function createApp(options: AppOptions) {
  const { accounts, environments, decider, webhooks, automatic, trustProxy } = options;
  const { db, events, entities, analytics, transaction } = options.repos;
  const now = options.now ?? (() => new Date());
  const onQueued = () => automatic?.wake();
  const users = new UsersService(db);
  const sessions = new SessionsService(db);
  const workspaces = new WorkspacesService(db);
  const rateLimits = new RateLimitsService(db);

  const environmentService = createEnvironments({ db, environments, now });
  const auth = authModule({
    accounts,
    users,
    rateLimits,
    sessions,
    workspaces,
    environments: environmentService,
    now,
    signup: options.signup ?? true,
    supabase: options.supabase,
    cognito: options.cognito,
    trustProxy,
    fetch: options.fetch ?? fetch,
  });
  const tenancy = tenancyModule({ db, accounts, sessions, environmentService, now });
  const environmentModule = environmentsModule({
    sessions,
    environments: environmentService,
    requireRole: tenancy.tenancy.requireRole,
    now,
  });
  const webhookModule = webhooksModule({
    sessions,
    tenancy: tenancy.tenancy,
    environments: environmentService,
    webhooks,
    repos: { db, entities, transaction },
    now,
    presets: options.presets ?? [],
    onQueued,
  });
  const ingest = ingestModule({ db, events, transaction, now, onQueued, trustProxy });
  const catalog = catalogModule({
    db,
    entities,
    events,
    transaction,
    now,
    webhooks,
    templates: options.entityTemplates ?? [],
  });
  const actionModule = actionsModule({ db, now, templates: options.templates ?? [], automatic });
  const decisionModule = decisionsModule({ db, events, entities, transaction, decider, now, webhooks });
  const observe = observeModule({ db, analytics, entities, now });
  const workflowModule = workflowsModule({
    repos: options.repos,
    now,
    decider,
    allowPrivate: webhooks?.allowPrivate ?? false,
    wake: onQueued,
  });
  const caseModule = casesModule({ repos: options.repos, now, webhooks, templates: options.viewTemplates ?? [] });
  const modelModule = modelsModule({ db, now });
  const rulesetModule = rulesetsModule({ db, now, templates: options.rulesetTemplates ?? [] });
  const listModule = listsModule({ db, now });
  const experimentModule = experimentsModule({ db, now, wake: onQueued });
  const jobModule = jobsModule({
    db,
    sessions,
    tenancy: tenancy.tenancy,
    environments: environmentService,
    now,
    onQueued,
  });
  const activities = activitiesModule({ db, sessions, requireRole: tenancy.tenancy.requireRole, now });
  const clients = clientsModule({
    db,
    environments: environmentService,
    sessions,
    requireRole: tenancy.tenancy.requireRole,
    now,
  });
  const cloudflare = cloudflareModule({
    tenancy: tenancy.tenancy,
    environments: environmentService,
    sessions,
    requireRole: tenancy.tenancy.requireRole,
    fetch: options.fetch ?? fetch,
    now,
  });
  const mcp = mcpModule({
    db,
    app: () => app,
    sessions,
    requireRole: tenancy.tenancy.requireRole,
    trustProxy,
    now,
  });

  const app = new Hono<Env>();
  app.get("/health", (c) => c.json({ ok: true }));
  app.use("*", activityLog({ db, now, trustProxy }));
  app.use("*", limitBody(MAX_REQUEST_BYTES));
  app.route("/internal", internalRoutes(webhooks, now, options.jobs));

  app.route("/auth", auth.routes);
  app.route("/app", tenancy.routes);
  app.route("/app", environmentModule.routes);
  app.route("/app", webhookModule.adminRoutes);
  app.route("/app", jobModule.routes);
  app.route("/app", mcp.adminRoutes);
  app.route("/app", clients.adminRoutes);
  app.route("/app", cloudflare.routes);
  app.route("/app", activities.routes);

  // Registered before the key check, which an inbound webhook and a workflow's webhook skip.
  app.route("/v1", webhookModule.inboundRoutes);
  app.route("/v1", workflowModule.hookRoutes);
  // A public key is made to be used from a browser, so events can be sent from any origin.
  app.use(
    "/v1/events",
    cors({
      origin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 86400,
    }),
  );
  app.use(
    "/v1/client-settings",
    cors({ origin: "*", allowMethods: ["GET", "OPTIONS"], allowHeaders: ["Authorization"], maxAge: 86400 }),
  );
  app.use("/v1/*", apiAuth({ db, trustProxy, now }));
  // Anyone can read a public key from a web page.
  app.use(
    "/v1/*",
    rateLimit(rateLimits, now, (c) =>
      c.get("publicKey") ? LIMITS.publicKey(c.get("apiKey")!.id, ipOf(c, trustProxy)) : [],
    ),
  );
  app.use("/v1/*", async (c, next) => (c.get("publicKey") ? limitBody(MAX_PUBLIC_BYTES)(c, next) : next()));

  app.route("/v1", webhookModule.presetRoutes);
  app.route("/v1", ingest.routes);
  app.route("/v1", catalog.routes);
  app.route("/v1", actionModule.routes);
  app.route("/v1", decisionModule.routes);
  app.route("/v1", workflowModule.routes);
  app.route("/v1", caseModule.routes);
  app.route("/v1", modelModule.routes);
  app.route("/v1", rulesetModule.routes);
  app.route("/v1", listModule.routes);
  app.route("/v1", experimentModule.routes);
  app.route("/v1", observe.routes);
  app.route("/v1", clients.routes);

  // The MCP Inspector and other browser clients send a key, not a cookie, so any origin can ask.
  app.use(
    "/mcp",
    cors({
      origin: "*",
      allowMethods: ["POST", "GET", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Mcp-Protocol-Version", "Mcp-Session-Id", "Last-Event-ID"],
      exposeHeaders: ["Mcp-Session-Id"],
      maxAge: 86400,
    }),
  );
  app.use("/mcp", apiAuth({ db, trustProxy, now }));
  app.route("/mcp", mcp.routes);

  app.onError((cause, c) => {
    if (cause instanceof AppError) return error(c, ERROR_STATUS[cause.kind], cause.type, cause.message);
    console.error(cause);
    return c.json({ error: { type: "internal_error", message: "Internal error" } }, 500);
  });

  return app;
}
