# Authentication

Kairos has two ways in. A program uses an **API key**. A person **signs in**, in the console or with the CLI. Each request is confined to one workspace and one [environment](environments.md), and nothing is read across either boundary.

| Who | How | Can use |
|---|---|---|
| Your server, a job, an agent | A secret key, `ksk_…` | The data API (`/v1`) and [MCP](../reference/mcp.md) |
| A browser or a mobile app | A public key, `kpk_…` | `POST /v1/events` only |
| A person | A session, after sign-in | The console, the data API, and the workspace settings (`/auth`, `/app`) |

## API keys

| Kind | Prefix | Can | Where it lives |
|---|---|---|---|
| Secret | `ksk_` | Every `/v1` endpoint, in its environment | Your server only |
| Public | `kpk_` | `POST /v1/events`, without `set` or `set_once`. Nothing else. | A browser or an app |

A key belongs to one workspace and one environment. It chooses both, so a request with a key needs no other scope: the SDK constructor and the request bodies are the same in every environment. Use a different key for each deployment. More than one key can use the same environment, for example one for Payments and one for Lending that share production history.

### Make a key

An owner or an admin makes keys. Each key belongs to one environment, the selected one unless you choose another:

- In the console: **Settings › API keys › Create key**. Choose the environment there; the selected one comes first.
- With the CLI, signed in with an email address: `kairos keys create payments --kind secret`.
- With the API: [`POST /app/workspaces/:workspace/keys`](../reference/api.md#api-keys).

Kairos shows the key one time, when it is made, and stores only its hash. Lists show a hint of each key, never the key.

### Send a key

Send the key as a bearer token:

```bash
curl https://kairos.finic.ai/v1/decide \
  -H "Authorization: Bearer $KAIROS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "action": "withdrawal", "entities": { "user": "user_42" }, "properties": { "usd": 900 } }'
```

The SDKs send it for you, to `https://kairos.finic.ai` unless you give another address:

```ts
import { Kairos } from "@finic-ai/kairos";

const kairos = new Kairos({ apiKey: process.env.KAIROS_API_KEY! });
```

```python
import os
from kairos import Kairos

kairos = Kairos(api_key=os.environ["KAIROS_API_KEY"])
```

Keep a secret key in your server's environment or secret store, never in a browser, a mobile app or a repository.

### Limit a key

- **IP addresses.** A key can have a list of IP addresses and IPv4 ranges (`203.0.113.7`, `198.51.100.0/24`). A request from another address gets 403 `ip_not_allowed`. IPv6 ranges are not supported; a single IPv6 address works.
- **Websites**, for a public key. A public key can have a list of allowed websites (`https://www.example.com`, `https://*.example.com` for every subdomain, `http://localhost:3000`). The server compares the list with the `Origin` header, and a request from another website, or with no `Origin`, gets 403 `origin_not_allowed`. A mobile app sends no `Origin`: give its key no website list.

### Change a key

In **Settings › API keys**, click a key to see its details: its hint, type, environment, when it was made and last used. You can change its name, its IP addresses and, for a public key, its websites. The new limits apply to the next request. The key itself, its type and its environment never change: for those, make a new key.

### Rotate and revoke

To change a key with no downtime, make a new key, deploy it, then revoke the old one in **Settings › API keys** or with `kairos keys revoke <id>`. A revoked key stops at once.

### Public keys

A public key lets anyone who has it write events into its environment. This is the same exposure as any client-side analytics key. A website list stops other websites from using the key in a browser, but not a script, which can send any `Origin`. Do not let an event from a public key be the only evidence for a decision.

## Signed-in people

A person signs in to the console (see [Workspaces](workspaces.md#accounts)). Sign-in sets the session cookie `kairos_session`: `HttpOnly`, `SameSite=Lax`, for 30 days. Kairos stores only a hash of the session token.

The console calls the same `/v1` API with that cookie and names its scope in two headers:

```http
X-Kairos-Workspace: ws_…
X-Kairos-Environment: env_…
```

The server checks on each request that the person is a member of the workspace and that the environment belongs to it. Without `X-Kairos-Environment`, the request uses Production. A key ignores both headers and always uses its own scope.

The workspace settings (`/app`), such as members, keys and environments, need a signed-in person. An API key cannot use them.

### The CLI

`kairos login` signs in to a server and keeps the connection as a profile:

```bash
kairos login --url https://kairos.finic.ai --key ksk_…
kairos login --url https://kairos.finic.ai --email you@example.com --workspace Acme --environment Production
kairos whoami
```

A sign-in with an email address, on a server that offers password sign-in, can use every command. A sign-in with a key can use the data API only, in the key's environment: commands such as `kairos keys`, `kairos environments` and `kairos models promote` need `--email`. `kairos use --environment Staging` changes the environment of a profile.

## Errors

| Status | `type` | When |
|---|---|---|
| 401 | `authentication_error` | No key and no session, or a key that is unknown or revoked. MCP also needs a secret key. |
| 403 | `public_key_scope` | A public key was used for anything but `POST /v1/events`. |
| 403 | `origin_not_allowed` | The `Origin` of the request is not in the key's website list. |
| 403 | `ip_not_allowed` | The address of the request is not in the key's IP list. |
| 403 | `workspace_suspended` | The key's workspace is suspended. |
| 403 | `forbidden` | The signed-in person is not a member of the workspace, or the membership is suspended. |
| 400 | `invalid_request` | A signed-in request to `/v1` with no `X-Kairos-Workspace`. |
| 404 | `not_found` | The `X-Kairos-Environment` is not an environment of the workspace. |

## Other credentials

- **Inbound webhooks** have their own URL token and signature check, not an API key. See [Inbound webhooks](webhooks/inbound.md#verification).
- **Outbound webhooks** are signed with the [Standard Webhooks](https://www.standardwebhooks.com) scheme. Check them with `verifyWebhook` in the [TypeScript SDK](../reference/clients/typescript.md) or `verify_webhook` in the [Python SDK](../reference/clients/python.md).
