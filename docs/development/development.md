# Working on Kairos

For people who change Kairos itself: where things are, how to run and test them, and how the server is put together. To use Kairos, start with [Local setup](local-setup.md).

## Layout

| Path | What it is |
|---|---|
| `apps/server` | The HTTP API: events, entities, labels, actions, decide, the decision log, dashboards, and sign-in with workspaces and API keys. Hono, with Postgres through Drizzle. See [The server](#the-server). |
| `apps/console` | The web console: decisions, entities, actions, dashboards and settings. React and Vite. |
| `apps/cli` | `kairos`, the CLI: starts Kairos, connects to a server, and calls its API. |
| `packages/core` | The decision path as a library: generic baseline and context builder, action definitions, Grayson client, policy. No I/O besides the model call, and no knowledge of any one product. |
| `packages/sdk` | `@finic-ai/kairos`, the TypeScript client. Start with the [SDK guide](../reference/clients/typescript.md). |
| `packages/sdk-python` | `finic-kairos`, the Python client. Standard library only. See the [Python SDK guide](../reference/clients/python.md). |
| `packages/kairosjs` | `kairosjs`, the browser library: visitor identifier, browser detection and bot detection. It does not use the server. Not in the repository: `.gitignore` leaves it out. |
| `packages/eval` | The evaluation suite: 100 synthetic cases, a cached runner, and an accepted baseline to compare against. |
| `templates/` | Action definitions used by the examples and evaluation suite, and recommended event shapes with a schema and an example. One JSON file each. See [Templates](../templates/overview.md). |
| `examples/` | Scenarios, end to end: bank transfers, merchant onboarding, fraud claims, ATM withdrawals, loans, insurance, health claims, push payment scams, event ticket purchases and ecommerce checkout. |

## Commands

```bash
pnpm install
pnpm test           # tests for core, server, CLI, console and SDK; no network. The server tests start a throwaway Postgres
pnpm test:python    # the tests of the Python SDK (python3, no packages needed)
pnpm typecheck
pnpm api            # start the API (needs GRAYSON_API_KEY, see .env.example). No database to install
pnpm example        # run examples/bank-transfer.ts against a local server (set KAIROS_API_KEY to a secret key from the console)
pnpm example:merchants  # run examples/merchant-onboarding.ts: 34 applications of six kinds
pnpm example:claims     # run examples/fraud-claims.ts: 34 fraud claims and 12 red flags
pnpm example:ticketing  # run examples/ticketing.ts: six event ticket purchase scenarios
pnpm example:ecommerce  # run examples/ecommerce.ts: six checkout scenarios
pnpm example:atm        # run examples/mule-atm.ts: mules and honest customers at the same ATM
pnpm example:session    # run examples/session.ts: a usual visit and a takeover visit of one customer
pnpm example:sessions   # run examples/sessions.ts: six visits with several decisions in each, some approved and some held
pnpm console        # start the web console on http://localhost:5273 (needs the server running)
pnpm eval:replay    # send the 100 evaluation cases through a running server, to fill it with data
pnpm eval           # run the evaluation suite and compare with the accepted baseline
pnpm eval:accept    # store the current result as the accepted baseline
pnpm eval:generate  # rewrite the case file (see packages/eval/src/generate.ts first)
pnpm build          # build the SDK to packages/sdk/dist
pnpm build:standalone   # build the server and the console to apps/server/dist
pnpm build:vercel       # build the same for Vercel, to .vercel/output
pnpm docs:events    # write docs/templates/events/*.md from the event templates
```

## The server

### Database

The server stores everything in Postgres, and it does not need one installed.

- **With no `DATABASE_URL`**, it starts its own Postgres (the [`embedded-postgres`](https://github.com/leinelissen/embedded-postgres) package, which carries the real Postgres binaries) and keeps the files in `apps/server/.data/postgres2`. The first start takes a few seconds to create them. `KAIROS_DATA_DIR` moves the files and `KAIROS_PG_PORT` (default 54329) moves the port. It stops when the server stops; if the server is killed, the next start finds it running and uses it. A Postgres of another data folder on that port is not used: the server stops and says which folder it serves.
- **With `DATABASE_URL`**, it connects to that Postgres and starts nothing. Use this for any deployment.

The tables are defined in `apps/server/src/db/schema/`, one file for each area, and the migrations in `apps/server/drizzle` are generated from it: one folder for each migration, named by its time, with `migration.sql` and the snapshot that `drizzle-kit` compares the next change with. The server uses Drizzle 1.0 (a release candidate, `1.0.0-rc.5`), for its relational queries. With the embedded Postgres, the server applies them when it starts. With `DATABASE_URL`, it does not: applying them is a step of the deployment (`pnpm db:migrate`, see [Deployment](../deployment/self-hosting.md#migrations)), and a server that finds the database behind stops with a message that names the migrations to apply.

The relations between the tables are in `apps/server/src/db/relations.ts`. With them, `db.query` loads related rows (`with: { event: true }`) and filters by them (`where: { labels: { label: "fraud" } }`). A relation does not scope a query: the query still filters by `workspace_id` and `environment_id`. A relation through a customer's id, such as the labels of an object, also matches the workspace and the environment, so it never reaches into another environment.

For a repository that needs no SQL of its own, `platform/orm.ts` has `DatabaseService`: typed reads and writes of one table, with Drizzle's filters and relations, inside one scope. `new DatabaseService(tx, "objects", { workspaceId, environmentId })` adds the scope to every filter and every write, makes the id, and sets `created` and `updated` from the `now` it is given. It skips the rules of the services (an event written with it is not ingested). Users, sessions, workspaces and jobs are global tables: they have no scope, and a write to them needs a filter. The table services in `services/` are built on it.

The migrations started again from one baseline in October 2026, in the new folder `.data/postgres2`. The database from before is still in `.data/postgres`, and the server does not open it. To keep its data, copy it once into the new database, which must be empty:

```bash
pnpm --filter @kairos/server db:copy-local                      # .data/postgres → .data/postgres2; --from <folder> for another one
```

The copy only reads the old database. If its Postgres runs, the copy reads it there; else it starts it read-only on port 54330. It copies in one transaction, so a failure leaves the new database empty. The old database must have migration `0007` or later. A user who had both a password and Supabase sign-in becomes a Supabase user, and the copy prints their email addresses. When the new database works, you can delete `.data/postgres`.

```bash
pnpm --filter @kairos/server db:generate                        # after a change to the schema
pnpm db:migrate                                                 # apply the migrations to DATABASE_URL (or to the embedded Postgres)
```

Most free-form values are `jsonb`. The ones that the model reads, or that a person wrote in an order (event properties, entity properties, action and entity definitions, the logged context), are `json`, because `jsonb` sorts the keys of an object and the order changes the answers of the model: over the 100 evaluation cases, 14 decisions changed with sorted keys, against 2 for the same request sent twice (`packages/eval/src/experiments/key-order.ts`). Two GIN indexes on those values cast to `jsonb` serve the property filters of the entity list and of the event metrics.

Every table except `event_entities` has an `id` primary key: a prefix and a ULID (`evt_…`, `kdec_…`), made by `newId` in `platform/crypto.ts`. The ids that a customer sends for events and entities are kept in `external_id`, and the API shows them as `id`. A copy that runs inside Postgres, such as the sandbox copy, makes ids with the SQL function `kairos_id(prefix, time)` from the baseline migration, in the same format.

The tests run against a throwaway embedded Postgres, or against `KAIROS_TEST_DATABASE_URL` if it is set. Each test file makes its own database in it.

### Structure

```
apps/server
  drizzle/            generated SQL migrations
  scripts/            one-off commands
  src/
    index.ts          entry: read the config, start listening, serve the console if there is a built one
    vercel.ts         entry of the Vercel function
    worker.ts         entry of the worker process: runs the background jobs, serves no HTTP
    migrate.ts        apply the migrations and stop (pnpm db:migrate)
    boot.ts           open the database, bring it up to date, build the app; both entries call it
    console.ts        serve the built console from the same address
    app.ts            build the HTTP app from the modules, and mount their routes
    context.ts        what the app is given
    internal.ts       the drain route that a scheduler calls on a function
    repositories.ts   the repositories of the data API, and one transaction across them
    types/            every module's types, for an import from one place
    db/schema/        the Drizzle schema: one file for each area, and index.ts
    services/         the table services: reads and writes of one table each, on DatabaseService
    platform/         what every module uses: config, the database, SQL and HTTP helpers, crypto, secrets, errors (error.ts)
      jobs/           the one worker for background work
      auth/           who is calling: the session cookie and requireSession, and the /v1 check of API keys (api-auth.ts)
    modules/          one folder for each area of the product
      auth/           sign-up, sign-in, Supabase, the signed-in person's account, and users and sessions
      tenancy/        workspaces, members, invites, API keys
      environments/   production and sandboxes, and what a sandbox copies
      ingest/         events, records, sessions
      catalog/        entity types, entities, labels
      actions/        action definitions, their versions, the templates
      decisions/      deciding, automatic decisions, the decision log and its resolutions
      webhooks/       inbound and outbound webhooks, their delivery log, and the cleanup job
      observe/        dashboards, metrics, usage, the overview
      workflows/      workflows and their runs
      cases/          queues and cases
      jobs/           the background work of every module, and the jobs of an environment for its admins
  test/
```

Each module has `index.ts` (its constructor: what it needs, and the routes it returns), `route.ts` (parse, call, answer), `service.ts` (the rules), `repo.ts` (SQL, when it has its own), `types.ts` and, when it reads a body, `schema.ts` (Zod). There is one file of each layer in a module: an area that needs a second repository or a second route file is a module of its own. Every other file of a module is in its `libs/` folder, such as the webhook signing in `webhooks/libs/`, and `libs/index.ts` exports them: code outside the folder imports `<module>/libs`, never a file inside it. In a module, only `repo.ts` runs SQL.

The code is formatted with Prettier, at a width of 120: `pnpm format` writes it, and `pnpm format:check` checks it. Long SQL inside a template string is not formatted by Prettier; write it with one clause on each line.

A request goes route → service → repository. A route does not write SQL, a repository does not know about HTTP and imports no service, and a service refuses a request by throwing an `AppError`. `test/structure.test.ts` checks the direction of the imports, the one file of each layer, the `libs/` folders and their index, and that only `repo.ts` runs SQL in a module.

### Rate limits

Every limit is in `LIMITS` in `src/services/rate_limit.service.ts`. A limit counts hits on a `key` in a window that starts at the first hit, in the table `rate_limits`. `resource` is a name such as `login`, or a route pattern such as `POST /v1/events`; `ip` is set when the limit counts one IP address. Start each key with a prefix that no other limit uses.

To limit a route, give `rateLimit` the limits of the request. It answers 429 `rate_limited` with `Retry-After`; `[]` means no limit:

```ts
app.post(
  "/entities/:type/:id/commands/:key",
  rateLimit(rateLimits, now, (c) => LIMITS.commands(c.get("apiKey")?.id ?? c.get("userId")!)),
  handler,
);
```

`routeOf(c)` gives the route pattern of the request, such as `POST /v1/entities/:type/:id`, both in middleware on the route and in `app.use`. When a hit depends on the body, call `rateLimits.hit(...)` and `rateLimited(c, wait)` in the handler, as `POST /auth/login` does; `undo` and `reset` take hits back. The hourly retention job deletes expired rows.

## Changing what a decision sees

The context that the model reads decides the answers, and small changes move them. The order of the keys in a JSON object alone changed 14 decisions in 100 (`packages/eval/src/experiments/key-order.ts`). So a change to the context builder, the questions or the policy is measured before it is kept: see [The evaluation suite](evaluation.md).

