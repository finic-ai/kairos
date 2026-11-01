# Edge

`@finic-ai/kairos-edge` runs the routes of your [client settings](../api.md#client-settings) in a Cloudflare Worker in front of your app. It sends their events and asks for their decisions with no change to your app. Every other request goes on to your app as it came.

- [Set it up](#set-it-up)
- [What the Worker does](#what-the-worker-does)
- [Who an event is about](#who-an-event-is-about)
- [With the middleware on your servers](#with-the-middleware-on-your-servers)
- [The website script](#the-website-script)
- [When something fails](#when-something-fails)
- [Reference](#reference)

## Set it up

Make a secret key in **Settings › API keys**. Then, in a Worker project:

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

Then set the routes in **Settings › Integrations › Client settings**, under **Edge & Middleware**. The Worker reads them again each minute, so a change needs no new deployment. It does not need `nodejs_compat`.

A Worker that you have already gives its handler to `cloudflare`. Kairos runs first, and your `fetch` takes each request where your app would. Your other handlers, such as `scheduled`, stay as they are:

```ts
export default cloudflare({
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
});
```

On a Kairos server of your own, set `KAIROS_URL` to its address, as a variable of the Worker.

## What the Worker does

For each request, the Worker removes every `x-kairos-*` header that came with it, and finds the first route for its method and path. A request that no route is for goes on with no other change. For a route, the Worker does what its mode says:

| Mode | What the Worker does | What the person waits for |
|---|---|---|
| Track | Sends the request on and gives back the response. Then sends the route's event. | Nothing |
| Decide on request | Asks Kairos before the request goes on. A `block` answers with the route's block response; a `step_up` redirects to the route's step-up page. Any other decision lets the request go on. | The decision |
| Decide on response | Sends the request on, then asks Kairos with the response: a sign-in that succeeded, for example. A `block` replaces the response, so its session cookie never reaches the person. | The decision |

A 4xx response sends the route's failed event, and a 5xx sends nothing. The route mode **Monitor** asks for decisions but never acts on them. **Active** lets the routes with **Enforce** on act. **Off** sends nothing for any route.

Decide on response suits a sign-in: your app has only made a session, and the Worker can hold it back. It does not suit a payment, because your app has moved the money by then. Decide on request for a payment.

The fields of a route are read as the [middleware](typescript.md#routes-from-the-console) reads them: from the query, the headers, the cookies, the parameters of the route, and the JSON body of the request and of the response, of at most 128 KB. A hashed field, a cookie and the session cookie are sent only as an HMAC with `KAIROS_HASH_KEY`.

## Who an event is about

- **The device** comes from the `kairos_device` cookie of the [website script](browser.md#the-device).
- **The IP address** comes from Cloudflare, as the `ip` entity.
- **The session** is the hash of the settings' session cookie, else the [visit](browser.md#the-visit) of the website script.
- **The country and the ASN** that Cloudflare gives are properties of each event, with the fields of the route.

The Worker does not know who is signed in. A field whose name ends in `Id` names an entity, so a field `userId`, from the response body of a sign-in, names the user. For the user on every route, run the middleware on your servers too.

## With the middleware on your servers

When your servers run the [TypeScript](typescript.md#routes-from-the-console) or [Python](python.md#routes-from-the-console) middleware with client settings on, the Worker and the middleware read the same routes. On each request they agree, so that a route sends its events once, and is decided once:

- **The Worker signs each request that it sends on**, in an `x-kairos-edge` header, with `KAIROS_HASH_KEY`. Give the Worker the same hash key as your servers.
- **The middleware sends the events of the route**, with the user who is signed in, and says so in an `x-kairos-tracked` header on the response. The Worker then sends no event, and removes that header.
- **The Worker decides a route that decides on the request.** The middleware gives its decision to your handler as `req.kairosDecision` (FastAPI: `request.state.kairos_decision`) and does not ask again. That decision has no reasons or rules: a request's headers have a size limit.
- **A header with a wrong signature is ignored**, and so is one for another method or path, or one more than five minutes old. A request that goes straight to your servers cannot say that it came from the Worker.

Decide on response is for the Worker only. The middleware skips such a route.

## The website script

Set `KAIROS_PUBLIC_KEY` to a public key, limited to your websites, and the Worker adds the [website script](browser.md) to the `<head>` of each HTML page. Then each browser gets its device and visit cookies, and sends the pages of your client settings, with no change to your site. A page that already has the script tag runs the script once.

## When something fails

- **An error of the Worker sends the request on.** A decision that fails or is too slow takes the route's fallback, `approve` unless the route says otherwise, after at most the route's timeout.
- **The settings are read on the first request**, and again each minute, in the background. Until the first read, every request goes on as it came. When a read fails, the Worker keeps the last settings.
- **With no `KAIROS_API_KEY`**, the Worker sends every request on, and says so once in its log.

## Reference

| Variable of the Worker | |
|---|---|
| `KAIROS_API_KEY` | A secret key (`ksk_`). A secret. |
| `KAIROS_HASH_KEY` | The same hash key as your servers'. A secret. Without it, hashed fields, cookies and the session cookie are left out, and the middleware cannot tell that the Worker sent a request. |
| `KAIROS_PUBLIC_KEY` | A public key (`kpk_`). With it, the Worker adds the website script to HTML pages. |
| `KAIROS_URL` | The address of a Kairos server of your own. Default: `https://kairos.finic.ai`. |

`cloudflare(handler?)` gives the Worker. With `handler`, its `fetch` takes the requests that go on; without it, they go to your origin.
