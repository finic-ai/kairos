# Website script

One script for your web pages. It gives each browser a device id, sends the pages that your [client settings](../api.md#client-settings) name as events, and sends the events that you track. It uses a public key, which can only send events.

- [Add it to your pages](#add-it-to-your-pages)
- [Who the user is](#who-the-user-is)
- [Events of your own](#events-of-your-own)
- [Pages](#pages)
- [Forms](#forms)
- [The device](#the-device)
- [The visit](#the-visit)
- [Consent](#consent)
- [From npm](#from-npm)
- [From a tag manager](#from-a-tag-manager)
- [Reference](#reference)

## Add it to your pages

Make a public key in **Settings › API keys**, and limit it to your websites. Then add one tag to every page:

```html
<script src="https://kairos.finic.ai/kairos.js" data-api-key="kpk_…" async></script>
```

On a server of your own, load `kairos.js` from its address. The script sends to the address it was loaded from.

## Who the user is

Set `window.kairos` before the tag. The script reads it when it starts:

```html
<script>
  window.kairos = { apiKey: "kpk_…", entities: { user: "user_123" }, session: "sess_7f3a" };
</script>
<script src="https://kairos.finic.ai/kairos.js" async></script>
```

Leave out the user when nobody is signed in. A single-page app that signs a person in later calls `kairos.setContext({ entities: { user: user.id } })`.

The page gives the user id, so whoever holds the browser can change it. Events from your server, with the same user id, are the ones to trust.

## Events of your own

Once the script has loaded, `window.kairos` is the client:

```js
kairos.track("coupon_applied", { code: "SPRING10" });
```

A key that ends in `Id` names an entity, as in the server SDKs. Every event of the script has the property `source: "browser"`.

For a call before the script has loaded, add a small stand-in to the snippet. It keeps the calls, and the client makes them when it starts:

```html
<script>
  window.kairos = { apiKey: "kpk_…", calls: [] };
  for (const method of ["track", "setContext", "consent"])
    window.kairos[method] = (...args) => window.kairos.calls.push([method, args]);
</script>
<script src="https://kairos.finic.ai/kairos.js" async></script>
```

## Pages

The script sends the event type of each page in the **Website** section of **Settings › Integrations › Client settings**, such as `/checkout` → `checkout_viewed`. A path can have parameters (`/payees/:id`) and end in `*` (`/account/*`). Single-page apps count too: the script follows `history.pushState`, `replaceState` and the back button. A page sends its event once for each new path.

A page event has the properties `path`, `referrer`, `user_agent`, `language`, `time_zone` and `screen`. Kairos adds the browser's IP address as the `ip` entity.

There is no event for every page: a decision reads the type of each step of a session, and steps called "page viewed" say nothing.

## Forms

The script watches each form with a sensitive field: a password, a card number, a bank account or a one-time code. That is a sign-in, a sign-up, a payment or a new payee. A search, a newsletter or a contact form is left alone. When such a form is submitted, the script sends `form_submitted`, with how the form was filled in:

| Property | |
|---|---|
| `form` | The form's `id`, else its `name`, else the path of its `action`. |
| `fields` | The kinds of field in it: `password`, `card`, `account`, `otp`, `email`, `phone`. |
| `duration_ms` | From the first time the form was touched to the submit. A bot takes milliseconds. |
| `pasted` | The kinds of field that had a paste. |
| `paste_count` | How many pastes. |
| `keys` | How many key presses. |
| `pointer` | Whether there was a mouse, pen or touch input. |
| `trusted` | `false` when a script dispatched the submit event itself. A script that calls `requestSubmit()`, or clicks the button, still gives `true`: `duration_ms`, `keys` and `pointer` show it. |
| `webdriver`, `headless` | Whether a tool drives the browser. Page events have these too. |

What was typed or pasted is never read. The kind of a field comes from its type, `autocomplete`, name and id. A form that your code sends with `fetch`, and never submits, sends nothing: give it a `submit` event, or call `track`.

## The device

The script makes a random id for the browser the first time, and keeps it in a first-party cookie, `kairos_device`, for a year, and in local storage. Every event of the script names it as the `device` entity. The [TypeScript](typescript.md#routes-from-the-console) and [Python](python.md#routes-from-the-console) middleware read the same cookie when it is on your domain, so your server's events name the same device.

The device changes when the person clears the browser's data, and a private window has its own. So every event also names the `browser` entity: a hash of what the browser shows of itself, such as how it draws text and shapes, its graphics card and fonts, its screen, time zone, languages and hardware. It is the same in a private window and after the cookies are cleared, so two accounts that come from one browser link even when the device does not. Two browsers of the same model and version can share it, and an update of the browser can change it, so a `browser` that many accounts share says little. The script reads it only once the page may send, and never sends the parts it is made of.

## The visit

The script also keeps the id of the visit in a cookie, `kairos_visit`, that ends with the browser session. A visit ends after 30 minutes with no event, and the next event starts a new one. An event that has no session of your own, from `session`, `setContext` or `$session`, takes the visit as its session, so that the steps of one visit are one session. `$session: null` leaves an event with no session.

The middleware reads the visit too: an event from your server that has no session takes it, so that a decision on the server sees the browser's steps before it.

When your API is on another subdomain, such as `api.example.com` for a site on `www.example.com`, set `cookieDomain: "example.com"` (with the tag: `data-cookie-domain`), so that the cookies reach it. Where they cannot, such as a native app or another domain, send them yourself:

```js
const { device, visit } = kairos.ids();
```

Both ids come from the browser, so whoever holds the browser can change them. They link a device and a visit; they never say who the user is.

## Consent

When **Ask for consent** is on in the client settings, the script sends nothing and sets no cookie until your page says so:

```js
kairos.consent(true);
```

Until then, events wait in the page. `kairos.consent(false)` drops them and stops sending.

## From npm

In a bundled app, such as React, Next.js or Vue, import the client:

```ts
import { Kairos } from "@finic-ai/kairos/browser";

const kairos = new Kairos({ apiKey: "kpk_…", entities: { user: user.id } });
kairos.track("coupon_applied", { code: "SPRING10" });
```

The import does not touch `window`, so it is safe in code that also renders on a server: make the client in the browser. On a server of your own, pass `baseUrl`.

## From a tag manager

In Google Tag Manager, add a **Custom HTML** tag that fires on every page:

```html
<script>
  window.kairos = { apiKey: "kpk_…", baseUrl: "https://kairos.finic.ai" };
</script>
<script src="https://kairos.finic.ai/kairos.js"></script>
```

## Reference

| Option | | |
|---|---|---|
| `apiKey` | required | A public key. With the tag only: `data-api-key`. |
| `baseUrl` | the address of the script | `https://kairos.finic.ai` with npm. |
| `entities` | none | Entity type → id, usually `{ user }`. |
| `session` | none | The login session in your own system. |
| `flushIntervalMs` | 2000 | Send at least this often. 0 sends only on `flush()` and when the page is left. |
| `cookieDomain` | this host | The domain of the cookies, such as `example.com`. With the tag only: `data-cookie-domain`. |
| `onError` | none | Called when events cannot be sent, or the client settings cannot be read. |

| Method | |
|---|---|
| `track(type, properties?)` | Records an event. Special properties: `eventId`, `timestamp`, `$session`. |
| `setContext({ entities?, session? })` | Who is acting from now on. |
| `consent(given)` | Starts or stops sending. |
| `ids()` | `{ device, visit }`, once the page may send. Before consent: `{}`. |
| `ready(fn)` | Runs `fn` with the client. |
| `flush()` | Sends what is waiting. The script also sends when the page is left. |
