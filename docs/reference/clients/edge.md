# Edge

`@finic-ai/kairos-edge` runs the routes of your [client settings](../api.md#client-settings) at the edge, in front of your app: in a Cloudflare Worker, a Fastly Compute service, or Lambda@Edge on CloudFront. It sends their events and asks for their decisions with no change to your app. Every other request goes on to your app as it came.

- [Cloudflare Workers](#cloudflare-workers)
- [Fastly Compute](#fastly-compute)
- [Lambda@Edge](#lambdaedge)
- [What the edge does](#what-the-edge-does)
- [Who an event is about](#who-an-event-is-about)
- [With the middleware on your servers](#with-the-middleware-on-your-servers)
- [JavaScript](#javascript)
- [When something fails](#when-something-fails)
- [Reference](#reference)

Each one needs a secret key from **Settings › API keys**. Then set the routes in **Settings › Integrations › Client settings**, under **Edge & Middleware**. The edge reads them again each minute, so a change needs no new deployment.

## Cloudflare Workers

### Deploy from Kairos

Kairos can put the Worker on your zone, with no project of your own. You need the admin role.

1. In Cloudflare, make an API token from the template **Edit Cloudflare Workers**, for the zone of your website.
2. In **Settings › Integrations › Cloudflare Workers**, choose **Deploy Worker**, paste the token and choose **Find zones**.
3. Choose the zone and the route, such as `example.com/*`. Only the requests on the route go through the Worker.
4. Give the hash key of your servers, if they run the Kairos middleware. Leave it empty, and Kairos makes one and shows it once: put it on your servers as `KAIROS_HASH_KEY`.
5. Choose whether the Worker adds the [JavaScript tag](#javascript) to your pages, then **Deploy**.

Kairos makes a secret key for the Worker in the environment that the console shows, named `Cloudflare Worker · example.com`, and a public key for the JavaScript tag. It uploads the Worker as `kairos-production` (for the environment Production), and routes it.

**Kairos uses the token for that deployment only, and does not keep it.** To update the Worker, deploy again with a token: the new keys replace the keys of the earlier deployment to the zone, which Kairos revokes. To remove the Worker, delete its route and the Worker in Cloudflare, and revoke its keys in **Settings › API keys**.

### Deploy it yourself

In a Worker project:

```sh
npm install @finic-ai/kairos-edge
```

```ts
// src/index.ts
import { cloudflare } from "@finic-ai/kairos-edge/cloudflare";

export default cloudflare();
```

```toml
# wrangler.toml
name = "kairos"
main = "src/index.ts"
compatibility_date = "2025-09-01"
routes = [{ pattern = "example.com/*", zone_name = "example.com" }]
```

```sh
npx wrangler secret put KAIROS_API_KEY
npx wrangler secret put KAIROS_HASH_KEY
npx wrangler deploy
```

The Worker does not need `nodejs_compat`. A Worker that you have already gives its handler to `cloudflare`. Kairos runs first, and your `fetch` takes each request where your app would. Your other handlers, such as `scheduled`, stay as they are:

```ts
export default cloudflare({
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
});
```

On a Kairos server of your own, set `KAIROS_URL` to its address, as a variable of the Worker.

## Fastly Compute

In a Compute project for JavaScript:

```sh
npm install @finic-ai/kairos-edge
```

```js
// src/index.js
import { fastly } from "@finic-ai/kairos-edge/fastly";

addEventListener("fetch", fastly());
```

The service needs two backends: `origin`, your app, and `kairos`, the host `kairos.finic.ai` on port 443, with TLS. It reads its keys from a Secret Store named `kairos`, which holds `KAIROS_API_KEY` and `KAIROS_HASH_KEY`. Link the store to the service, then publish it with `fastly compute publish`.

Other names go in the options: `fastly({ backend: "app", kairosBackend: "kairos-api", store: "secrets" })`. With `handler`, your own code takes the requests that go on, in place of the `origin` backend. On a Kairos server of your own, point the `kairos` backend at it, and put its address in the store as `KAIROS_URL`.

Fastly starts a new sandbox for each request, so the service keeps the settings in the cache of each point of presence, for a minute.

## Lambda@Edge

Lambda@Edge has no environment variables, so the keys go in the code, or come from a secret store that you read once for each instance:

```ts
// index.ts
import { lambdaEdge } from "@finic-ai/kairos-edge/lambda";

const kairos = lambdaEdge({ apiKey: "ksk_…", hashKey: "…" });

export const originRequest = kairos.originRequest;
export const originResponse = kairos.originResponse;
```

```ts
const kairos = lambdaEdge(async () => ({ apiKey: await readSecret("kairos-api-key"), hashKey: await readSecret("kairos-hash-key") }));
```

1. Bundle `index.ts` into one file, for example with `esbuild index.ts --bundle --platform=node --format=esm --outfile=dist/index.mjs`.
2. Make two functions from the bundle in `us-east-1`, on Node.js 20 or later, for x86_64: one with the handler `index.originRequest`, and one with `index.originResponse`.
3. In the CloudFront behavior for your app, add the first on **Origin request**, with **Include body** on, and the second on **Origin response**.
4. In the behavior's origin request policy, send to the origin the `kairos_device` and `kairos_visit` cookies, your session cookie, the headers and the query strings that your routes read, and the `CloudFront-Viewer-Country` and `CloudFront-Viewer-ASN` headers. The functions see only what the policy sends.

Lambda@Edge is not the same as the others in four ways:

- **A request waits for its sends.** There is no work after the response, so a route that tracks adds the time of one call to Kairos.
- **The response's body cannot be read.** CloudFront does not give it to the origin response function, so a route reads only the response's status and headers. The request's body reaches only the origin request function, which passes the route's fields of it on, signed with the hash key.
- **The functions run only when CloudFront goes to the origin.** A response from CloudFront's cache runs neither. A route of a method that CloudFront caches, such as `GET`, runs only on a miss.
- **The JavaScript tag is not added for you.** Add it to your pages.

## What the edge does

For each request, the edge removes every `x-kairos-*` header that came with it, and finds the first route for its method and path. A request that no route is for goes on with no other change. For a route, the edge does what its mode says:

| Mode | What the edge does | What the person waits for |
|---|---|---|
| Track | Sends the request on and gives back the response. Then sends the route's event. | Nothing, except on Lambda@Edge |
| Decide on request | Asks Kairos before the request goes on. A `block` answers with the route's block response; a `step_up` redirects to the route's step-up page. Any other decision lets the request go on. | The decision |
| Decide on response | Sends the request on, then asks Kairos with the response: a sign-in that succeeded, for example. A `block` replaces the response, so its session cookie never reaches the person. | The decision |

A 4xx response sends the route's failed event, and a 5xx sends nothing. The route mode **Monitor** asks for decisions but never acts on them. **Active** lets the routes with **Enforce** on act. **Off** sends nothing for any route. What the edge answers in place of your app is never cached.

Decide on response suits a sign-in: your app has only made a session, and the edge can hold it back. It does not suit a payment, because your app has moved the money by then. Decide on request for a payment.

The fields of a route are read as the [middleware](typescript.md#routes-from-the-console) reads them: from the query, the headers, the cookies, the parameters of the route, and the JSON body of the request and of the response, of at most 128 KB. A hashed field, a cookie and the session cookie are sent only as an HMAC with `KAIROS_HASH_KEY`.

## Who an event is about

- **The device** comes from the `kairos_device` cookie of the [JavaScript tag](browser.md#the-device).
- **The IP address** comes from the platform, as the `ip` entity.
- **The session** is the hash of the settings' session cookie, else the [visit](browser.md#the-visit) of the JavaScript tag.
- **The country and the ASN** that the platform gives are properties of each event, with the fields of the route.

The edge does not know who is signed in. A field whose name ends in `Id` names an entity, so a field `userId`, from the response of a sign-in, names the user. For the user on every route, run the middleware on your servers too.

## With the middleware on your servers

When your servers run the [TypeScript](typescript.md#routes-from-the-console) or [Python](python.md#routes-from-the-console) middleware with client settings on, the edge and the middleware read the same routes. On each request they agree, so that a route sends its events once, and is decided once:

- **The edge signs each request that it sends on**, in an `x-kairos-edge` header, with `KAIROS_HASH_KEY`. Give the edge the same hash key as your servers.
- **The middleware sends the events of the route**, with the user who is signed in, and says so in an `x-kairos-tracked` header on the response. The edge then sends no event, and removes that header.
- **The edge decides a route that decides on the request.** The middleware gives its decision to your handler as `req.kairosDecision` (FastAPI: `request.state.kairos_decision`) and does not ask again. That decision has no reasons or rules: a request's headers have a size limit.
- **A header with a wrong signature is ignored**, and so is one for another method or path, or one more than five minutes old. A request that goes straight to your servers cannot say that it came from the edge.

Decide on response is for the edge only. The middleware skips such a route.

## JavaScript

On Cloudflare and Fastly, set `KAIROS_PUBLIC_KEY` to a public key, limited to your websites, and the edge adds the [JavaScript tag](browser.md) to the `<head>` of each HTML page. Then each browser gets its device and visit cookies, and sends the pages of your client settings, with no change to your site. A page that already has the script tag runs the script once.

## When something fails

- **An error of the edge sends the request on**, and goes to the platform's log. A decision that fails or is too slow takes the route's fallback, `approve` unless the route says otherwise.
- **Until the settings are first read**, every request goes on as it came. When a read fails, the edge keeps the last settings.
- **With no `KAIROS_API_KEY`**, the edge sends every request on, and says so in its log.

## Reference

| Value | |
|---|---|
| `KAIROS_API_KEY` | A secret key (`ksk_`). Required. |
| `KAIROS_HASH_KEY` | The same hash key as your servers'. Without it, hashed fields, cookies and the session cookie are left out, the middleware cannot tell that the edge sent a request, and Lambda@Edge loses the fields of the request's body. |
| `KAIROS_PUBLIC_KEY` | A public key (`kpk_`). With it, the edge adds the JavaScript tag to HTML pages. Not on Lambda@Edge. |
| `KAIROS_URL` | The address of a Kairos server of your own. Default: `https://kairos.finic.ai`. |

On Cloudflare, these are the Worker's secrets and variables. On Fastly, they are entries of the Secret Store. On Lambda@Edge, they are `apiKey`, `hashKey` and `baseUrl`.

- `cloudflare(handler?)` gives the Worker. With `handler`, its `fetch` takes the requests that go on.
- `fastly(options?)` gives the listener for `fetch` events. Options: `backend` (default `origin`), `kairosBackend` (default `kairos`), `store` (default `kairos`) and `handler`.
- `lambdaEdge(options)` gives `originRequest` and `originResponse`. `options` is `{ apiKey, hashKey?, baseUrl?, onError? }`, or a function that gives it.
