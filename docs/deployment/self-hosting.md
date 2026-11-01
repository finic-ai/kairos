# Self-hosting

How to run Kairos on your own infrastructure, for other people to use. To use Kairos without running it, sign up at [kairos.finic.ai](https://kairos.finic.ai). Every variable is on [Configuration](configuration.md), and sign-up and sign-in options are on [Sign-in and access](sign-in.md).

- [What a deployment is](#what-a-deployment-is)
- [Docker Compose](#docker-compose): the quickest way to a working server
- [The image with your own Postgres](#the-image-with-your-own-postgres)
- [Without Docker](#without-docker)
- [Migrations](#migrations)
- [A separate worker](#a-separate-worker)
- [HTTPS and a reverse proxy](#https-and-a-reverse-proxy)
- [Upgrades](#upgrades) · [Backups](#backups) · [Scaling](#scaling) · [Monitoring](#monitoring)
- [Security checklist](#security-checklist)
- [Vercel](#vercel)

## What a deployment is

One process and one database.

- **The server** is a single JavaScript file, `server.mjs`, that runs on Node.js 22. It serves the API and the console from the same address, so there is nothing else to host and no CORS to configure for the console.
- **The database** is Postgres. A deployment connects to one through `DATABASE_URL`. The embedded Postgres of development is not in a built server.
- **The model** is called over the internet: the server needs to reach the Finic API, and it needs a `GRAYSON_API_KEY`.
- **Deploy from Kairos** for Cloudflare Workers calls `api.cloudflare.com` from the server, with the token that the person gives.

The server keeps no state of its own. Everything is in Postgres.

## Docker Compose

```bash
cp .env.example .env
```

Set two values in `.env`, and a third for webhooks:

```bash
GRAYSON_API_KEY=your_key
POSTGRES_PASSWORD=a_long_random_password
KAIROS_ENCRYPTION_KEY=output_of_openssl_rand_-base64_32
```

Set `POSTGRES_PASSWORD` before the first start. Postgres keeps the password it was first given, and changing the variable later does not change it.

```bash
docker compose up --build -d
```

This starts three things, in order:

1. **`postgres`**: Postgres 17, with its data in the volume `kairos-postgres`.
2. **`migrate`**: applies the migrations and stops.
3. **`kairos`**: the server, on port 8787. It starts only after `migrate` has succeeded.

Open `http://localhost:8787` and create the first account. `PORT` in `.env` changes the port on the host.

## The image with your own Postgres

For a managed Postgres, or one you already run, use the image alone.

```bash
docker build -t kairos .

# The migrate step: once for each release, before the server starts.
docker run --rm -e DATABASE_URL=postgres://user:password@host:5432/kairos kairos node migrate.mjs

docker run -d --name kairos -p 8787:8787 \
  -e DATABASE_URL=postgres://user:password@host:5432/kairos \
  -e GRAYSON_API_KEY=your_key \
  kairos
```

The image is `node:22-slim` with one directory, `/app`: `server.mjs`, `worker.mjs`, `migrate.mjs`, the migrations, the action and webhook templates and the built console. It has no `node_modules`, runs as the user `node`, and has a health check on `/health`.

Kairos is tested with Postgres 17 and 18. The database needs no extensions. The user needs to create tables and indexes in the `public` schema and to create the schema `drizzle`, where the list of applied migrations is kept.

## Without Docker

```bash
pnpm install
pnpm build:standalone        # writes apps/server/dist
```

Copy `apps/server/dist` to the server. It is complete: it needs Node.js 22 and nothing installed beside it.

```bash
cd dist
export DATABASE_URL=postgres://user:password@host:5432/kairos
export GRAYSON_API_KEY=your_key
export KAIROS_MIGRATIONS=$PWD/drizzle KAIROS_TEMPLATES=$PWD/templates KAIROS_CONSOLE=$PWD/console

node migrate.mjs             # the migrate step
node server.mjs
```

Run `server.mjs` under whatever keeps a process alive on your system (systemd, for example), and stop it with `SIGTERM`.

## Migrations

**Applying migrations is a step of the deployment, not something the server does.**

- Run the migrate step **once for each release, before the new servers start**: `node migrate.mjs` in a built server, or `pnpm db:migrate` from the repository.
- It needs only `DATABASE_URL`.
- It is **safe to run again**: what is applied is left alone, and it then says "The database is up to date."
- It is **safe to run twice at the same moment**: a lock in the database makes the second run wait.
- It runs in **one transaction**. If it fails, nothing is changed.

A server that starts on a database that is behind **does not serve**. It stops with a message that names the migrations that are missing:

```
The database is 1 migration behind (20261028021909_baseline). Run the migrate step (`pnpm db:migrate`, or `node migrate.mjs` in a built server), then start the server again. See docs/deployment/self-hosting.md.
```

This is deliberate: a server on an old schema would fail on the first query that needs the new one.

Two things to know:

- **A migration that builds an index on a large table blocks writes to that table while it runs.** Plan such a release for a quiet period. Before an upgrade, read the new files in `apps/server/drizzle`: a `CREATE INDEX` or an `ALTER COLUMN … SET DATA TYPE` on `events` or `decisions` is such a migration.
- **For one container that does both**, set `KAIROS_MIGRATE_ON_START=1`. The server then applies the migrations itself when it starts. This is convenient for a small deployment, and wrong for one with several servers or a short start-up limit.

## A separate worker

By default, each server also runs the background jobs. To keep that work away from the API, for example so that slow model calls for automatic decisions do not share a process with requests, set `KAIROS_WORKER=separate` on the servers and run one or more workers:

```bash
node worker.mjs        # in the image: docker run … kairos node worker.mjs
```

- The worker needs the same environment as the server: `DATABASE_URL`, `GRAYSON_API_KEY` and `KAIROS_ENCRYPTION_KEY` at least. It serves no HTTP, so it has no `/health`.
- Any number of servers and workers can share one database. Each job is claimed by one process at a time, and a job of a process that stops is claimed again when its lease ends.
- With `separate`, a job waits up to one second for a worker to claim it. Without a worker, jobs wait in the table and nothing is sent.
- The webhook **Send test message** button still sends from the server, because the person waits for its answer.
- `docker compose`: `KAIROS_WORKER=separate docker compose --profile worker up --build` starts a `worker` container next to the server.

## HTTPS and a reverse proxy

The server speaks plain HTTP. Put it behind something that ends TLS: a load balancer, Caddy, nginx. Then set:

```bash
KAIROS_TRUST_PROXY=1
```

With it, the server reads the caller's address from `X-Forwarded-For` (for the IP limits of API keys) and marks the session cookie `Secure` when `X-Forwarded-Proto` is `https`.

**Set it only behind a proxy that sets those headers itself.** If the server can be reached directly, a caller can write `X-Forwarded-For` and pass the IP limit of a key.

A complete Caddy configuration:

```
kairos.example.com {
  reverse_proxy localhost:8787
}
```

For nginx, pass the headers:

```nginx
location / {
  proxy_pass http://127.0.0.1:8787;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

A decision takes a few hundred milliseconds, and the server waits up to 10 seconds for the model with two retries. Give the proxy a read timeout of at least 35 seconds.

## The first account

The first person to create an account on a new server owns it. Create your account as soon as the server starts, then close sign-up with `KAIROS_SIGNUP=invite`. See [Sign-in and access](sign-in.md).

## Upgrades

1. Read the new migration files in `apps/server/drizzle` for one that locks a large table (see [Migrations](#migrations)).
2. Build or pull the new image.
3. Run the migrate step with the new image.
4. Start the new servers and stop the old ones.

With Docker Compose, `docker compose up --build -d` does steps 2 to 4 in the right order.

A migration can change the schema in a way the old server does not understand. Do not leave old servers running after the migrate step for longer than the switch takes. Kairos has no downgrade: to go back, restore the backup you took before the upgrade.

## Backups

Everything is in the one Postgres database. Back it up as you would any Postgres:

```bash
pg_dump --format=custom "$DATABASE_URL" > kairos-$(date +%F).dump
pg_restore --clean --dbname "$DATABASE_URL" kairos-2026-10-12.dump
```

With Docker Compose:

```bash
docker compose exec -T postgres pg_dump -U kairos --format=custom kairos > kairos-$(date +%F).dump
```

Take a backup before every upgrade. The decision log (`decisions`) holds the context of every decision and grows fastest for its size; `events` grows fastest in rows.

## Scaling

- **The server is stateless.** Run as many as you want behind a load balancer. No sticky sessions are needed.
- **Each server holds up to 10 database connections.** Size Postgres, or a pooler, for 10 times the number of servers, plus the migrate step.
- **A decision is a few queries and one model call.** The model call is most of the time. The limit of your Finic organization on requests per second is the first ceiling you will meet: past it, `decide` answers `502 model_unavailable`.
- **Events are written in batches of up to 500**, in one transaction for each batch.
- **Reading is computed when asked.** The entity list, the session list and the metrics query the stored rows. Kairos has not been measured at large volume: expect these to need rollup tables as the event table grows. One metric reads at most 250,000 rows.

## Monitoring

- `GET /health` answers `{ "ok": true }` when the process is up. It does not query the database.
- The server writes one line when it starts, and an error with its stack for every `500`.
- `GET /v1/usage` and **Settings › Usage** in the console show events, decisions and model tokens for each day.
- Watch the rate of `502` from `decide`: it is the model being unreachable or over its limit.

## Security checklist

- [ ] HTTPS in front, and `KAIROS_TRUST_PROXY=1` only behind your own proxy.
- [ ] The server is not reachable except through the proxy.
- [ ] Your account was the first one, and `KAIROS_SIGNUP=invite` is set ([Sign-in and access](sign-in.md)).
- [ ] `POSTGRES_PASSWORD` is not the default, and Postgres is not reachable from the internet.
- [ ] `GRAYSON_API_KEY`, `DATABASE_URL` and `KAIROS_ENCRYPTION_KEY` come from your secret store, not from a file in the image.
- [ ] `KAIROS_WEBHOOKS_ALLOW_PRIVATE` is not set.
- [ ] Secret keys (`ksk_`) are only on your servers. Browsers and apps get public keys (`kpk_`), limited to your websites.
- [ ] Server keys are limited to the IP addresses of your servers where those are fixed.
- [ ] Backups run, and a restore was tried once.

How the server stores passwords, keys and secrets: [Sign-in and access](sign-in.md#how-the-server-keeps-credentials).

## Vercel

Kairos also runs on Vercel, as static files for the console and one Node.js function for the API.

Import the repository in Vercel, or run `vercel` in it. `vercel.json` sets the build to `pnpm build:vercel && pnpm db:migrate`: the build writes `.vercel/output`, and then applies the migrations, so the function never does.

| Variable | |
|---|---|
| `GRAYSON_API_KEY` | Necessary. |
| `DATABASE_URL` | Necessary **for the build and for the function**. A Postgres that both can reach, such as Neon or Supabase. Use the pooled connection string: each instance of the function holds up to 10 connections. |
| `KAIROS_SIGNUP`, `SUPABASE_*` | Optional: see [Sign-in and access](sign-in.md). |
| `KAIROS_ENCRYPTION_KEY` | For webhooks: see [Configuration](configuration.md#webhooks-and-workflows). |
| `CRON_SECRET` | For webhook retries. At least 16 characters: `openssl rand -hex 32`. Vercel sends it to the cron route. Set it for the build and for the function. |
| `KAIROS_CRON_SCHEDULE` | Optional. The schedule of the retry cron. Default `* * * * *`, every minute (Pro). On Hobby, a daily one. |

- **Give preview deployments their own database.** A preview build runs the migrate step against the `DATABASE_URL` of the preview environment. If that is the production database, a preview changes the production schema before the production release.
- `KAIROS_TRUST_PROXY` is always on in the function, because every request comes through Vercel's proxy.
- **Outgoing webhooks need `KAIROS_ENCRYPTION_KEY` and `CRON_SECRET`.** A function sends the first attempt of each delivery itself, after its answer. It cannot retry later, because it stops: Vercel Cron does that by calling `/internal/jobs/drain`. The build adds that cron job only when `CRON_SECRET` is set in the project. Without it, a failed delivery is not tried again, and the webhooks page says so. The same cron job also retries automatic decisions whose first try failed, for example because the model was down.
- **On the Hobby plan, set `KAIROS_CRON_SCHEDULE` to a daily schedule**, such as `0 3 * * *`. Vercel refuses a Hobby deployment whose cron runs more than once a day, sometimes with no error in the dashboard. With a daily schedule, a failed delivery waits up to a day for its retry. For retries every minute, use a paid plan, or leave `KAIROS_CRON_SCHEDULE` daily and call the route from another scheduler (see below).
- The function may run for 60 seconds. One call of the drain route sends for at most 45 of them; what is left goes on the next call.

**Retries from another scheduler.** Any scheduler that can make an HTTP request each minute can do what Vercel Cron does, for example a GitHub Actions schedule or an uptime monitor:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://your-kairos.vercel.app/internal/jobs/drain
```

The answer says how many jobs were run and how many old webhook deliveries were deleted: `{"attempted":2,"deleted":0}`.
