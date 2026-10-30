# Configuration

A self-hosted server is set through environment variables. Only two are necessary. The server checks the configuration once, when it starts, and stops with a message if a value is missing or wrong.

## The server

| Variable | | |
|---|---|---|
| `GRAYSON_API_KEY` | necessary | The key for the model, from [portal.finic.ai/keys](https://portal.finic.ai/keys). |
| `DATABASE_URL` | necessary | `postgres://user:password@host:5432/database`. For a managed Postgres that needs TLS, add what your provider says, for example `?sslmode=require`. |
| `PORT` | | The port the server listens on. Default 8787. |
| `KAIROS_TRUST_PROXY` | | `1` behind a reverse proxy: the server reads the caller's address from `X-Forwarded-For` and marks the session cookie `Secure`. See [HTTPS and a reverse proxy](self-hosting.md#https-and-a-reverse-proxy). |
| `KAIROS_MIGRATE_ON_START` | | `1`: the server applies the migrations at start. `0`: it never does. See [Migrations](self-hosting.md#migrations). |
| `KAIROS_WORKER` | | Where the background jobs run: webhook deliveries, automatic decisions, workflow runs, queue rules, cleanup. `inline` (default): in the server. `separate`: in worker processes. See [A separate worker](self-hosting.md#a-separate-worker). |
| `KAIROS_CONSOLE` | | The directory of the built console. When set, the server serves the console and these docs. The image sets it. |
| `KAIROS_MIGRATIONS` | | The directory of the migrations. The image sets it. |
| `KAIROS_TEMPLATES` | | The directory of the action, entity, webhook and case layout templates. The image sets it. |

## Sign-in

| Variable | |
|---|---|
| `KAIROS_SIGNUP` | `invite`: a new account needs an invite link. Default: anyone who can reach the server can create an account. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Offer sign-in through Supabase Auth as well as email and password. Both are needed. |
| `SUPABASE_PROVIDERS` | The OAuth providers enabled in the Supabase project, for example `google,github`. |

See [Sign-in and access](sign-in.md).

## Webhooks and workflows

| Variable | |
|---|---|
| `KAIROS_ENCRYPTION_KEY` | Necessary for webhooks. 32 bytes as base64 (`openssl rand -base64 32`) or as 64 hexadecimal characters. Encrypts the signing secrets of outbound webhooks and the secrets of inbound sources. Without it, webhooks cannot be created. Keep it with your other secrets and never change it: secrets sealed with one key cannot be read with another. |
| `KAIROS_WEBHOOK_PAYLOAD_DAYS` | Days a webhook delivery keeps its payload in the log. Default 7; `0` keeps none. The row of each delivery stays for 30 days. |
| `KAIROS_SECRET_<NAME>` | A secret that a workflow's HTTP step reads as `{{ secrets.NAME }}`. Kairos never logs its value. A step that names a secret the server does not have fails, with the name of the variable to set. |
| `CRON_SECRET` | Opens `GET /internal/jobs/drain` to a caller that sends `Authorization: Bearer <CRON_SECRET>`. A server that keeps running does its background work itself and does not need it; it is for Vercel, or a scheduler outside Kairos. At least 16 characters. |
| `KAIROS_CRON_SCHEDULE` | On Vercel only: the schedule of the job cron. See [Vercel](self-hosting.md#vercel). |

## Development only

Never set these on a server that others use.

| Variable | |
|---|---|
| `KAIROS_WEBHOOKS_ALLOW_PRIVATE` | `1`: webhooks and workflow HTTP steps may call `http://` and private or local addresses. |
| `KAIROS_DATA_DIR`, `KAIROS_PG_PORT` | The embedded Postgres that starts when `DATABASE_URL` is not set. |
