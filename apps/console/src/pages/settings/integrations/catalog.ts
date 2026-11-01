import android from "../../../assets/integrations/android.svg";
import api from "../../../assets/integrations/api.svg";
import apple from "../../../assets/integrations/apple.svg";
import cloudflare from "../../../assets/integrations/cloudflare.svg";
import express from "../../../assets/integrations/express.svg";
import fastapi from "../../../assets/integrations/fastapi.svg";
import fastly from "../../../assets/integrations/fastly.svg";
import googletagmanager from "../../../assets/integrations/googletagmanager.svg";
import hono from "../../../assets/integrations/hono.svg";
import javascript from "../../../assets/integrations/javascript.svg";
import lambda from "../../../assets/integrations/lambda.svg";
import nodejs from "../../../assets/integrations/nodedotjs.svg";
import python from "../../../assets/integrations/python.svg";
import react from "../../../assets/integrations/react.svg";

export type Kind = "web" | "mobile" | "server" | "edge";

export const KINDS: { id: Kind; title: string }[] = [
  { id: "web", title: "Web" },
  { id: "mobile", title: "Mobile" },
  { id: "server", title: "Server" },
  { id: "edge", title: "Edge" },
];

export interface Step {
  title: string;
  /** Made when the page is shown: the key and the address of this server go in. */
  code: (key: string, origin: string) => string;
}

export interface Integration {
  slug: string;
  name: string;
  kind: Kind;
  logo: string;
  /** A one-colour logo, turned white on a dark background. */
  mono?: boolean;
  note: string;
  overview: string[];
  /** The documentation of one that is available. One without it is coming. */
  docs?: string;
  /** How to install one that is available. */
  steps?: Step[];
  /** What one that is coming will do. */
  plans?: string[];
  /** Whether it reads the client settings of the environment. */
  clientSettings?: boolean;
  /** The kind of key it takes: a public key in a web page, a secret one on a server. */
  key?: "public" | "secret";
}

export const KEY_PLACEHOLDERS = { secret: "<YOUR_SECRET_KEY>", public: "<YOUR_PUBLIC_KEY>" } as const;

const HOSTED = "https://kairos.finic.ai";
const tsClient = (origin: string) =>
  origin === HOSTED
    ? "new Kairos({ apiKey: process.env.KAIROS_API_KEY! })"
    : `new Kairos({ apiKey: process.env.KAIROS_API_KEY!, baseUrl: "${origin}" })`;
const pyClient = (origin: string) =>
  origin === HOSTED
    ? 'Kairos(os.environ["KAIROS_API_KEY"])'
    : `Kairos(os.environ["KAIROS_API_KEY"], base_url="${origin}")`;
const envStep: Step = {
  title: "Add your secret key to the server's environment",
  code: (key) => `KAIROS_API_KEY=${key}`,
};
const middlewareEnvStep: Step = {
  title: "Add your secret key, and a hash key of your own, to the server's environment",
  code: (key) => `KAIROS_API_KEY=${key}
# The same on every server. Make one with: openssl rand -hex 32
KAIROS_HASH_KEY=<A_LONG_RANDOM_SECRET>`,
};
const npmStep: Step = { title: "Install", code: () => "npm install @finic-ai/kairos" };

export const INTEGRATIONS: Integration[] = [
  {
    slug: "javascript",
    name: "JavaScript",
    kind: "web",
    logo: javascript,
    note: "One script tag. Tracks the pages in your client settings and the device of each visitor.",
    overview: [
      "Add one script to each page of your website. It sends the pages in your client settings as events, and how each sign-in, payment or payee form was filled in, and gives each browser a device id in a first-party cookie, kairos_device, that your server can read.",
      "Use a public key, and limit it to your websites in Settings › API keys. When your client settings ask for consent, the script sends nothing and sets no cookie until your page calls kairos.consent(true).",
    ],
    docs: "/docs/reference/clients/browser",
    clientSettings: true,
    key: "public",
    steps: [
      {
        title: "Add the script to every page",
        code: (key, origin) => `<script src="${origin}/kairos.js" data-api-key="${key}" async></script>`,
      },
      {
        title: "Say who the user is, and send events of your own",
        code: (key, origin) => `<script>
  window.kairos = { apiKey: "${key}", entities: { user: "user_123" }, calls: [] };
  for (const method of ["track", "setContext", "consent"])
    window.kairos[method] = (...args) => window.kairos.calls.push([method, args]);
</script>
<script src="${origin}/kairos.js" async></script>

<script>
  kairos.track("coupon_applied", { code: "SPRING10" });
</script>`,
      },
      {
        title: "Or, in a bundled app, from npm",
        code: (key, origin) => `import { Kairos } from "@finic-ai/kairos/browser";

const kairos = new Kairos({ apiKey: "${key}"${origin === HOSTED ? "" : `, baseUrl: "${origin}"`}, entities: { user: user.id } });`,
      },
    ],
  },
  {
    slug: "google-tag-manager",
    name: "Google Tag Manager",
    kind: "web",
    logo: googletagmanager,
    note: "Add the website script from a Custom HTML tag.",
    overview: [
      "Add the website script to your site from Google Tag Manager, with no change to your code. Use a public key, limited to your websites.",
    ],
    docs: "/docs/reference/clients/browser#from-a-tag-manager",
    clientSettings: true,
    key: "public",
    steps: [
      {
        title: "Add a Custom HTML tag that fires on every page",
        code: (key, origin) => `<script>
  window.kairos = { apiKey: "${key}", baseUrl: "${origin}" };
</script>
<script src="${origin}/kairos.js"></script>`,
      },
    ],
  },
  {
    slug: "react-native",
    name: "React Native",
    kind: "mobile",
    logo: react,
    note: "Track the screens of your app and its device.",
    overview: ["Track the screens of your React Native app, and give each install a device id."],
    plans: [
      "Track the screens in your client settings, by their names in React Navigation.",
      "The same track and setContext methods as the website script.",
    ],
    clientSettings: true,
  },
  {
    slug: "ios",
    name: "iOS",
    kind: "mobile",
    logo: apple,
    mono: true,
    note: "Swift package for iPhone and iPad apps.",
    overview: ["Track the screens of your iOS app, and give each install a device id."],
    plans: ["A Swift package.", "Track the screens in your client settings."],
    clientSettings: true,
  },
  {
    slug: "android",
    name: "Android",
    kind: "mobile",
    logo: android,
    note: "Kotlin library for Android apps.",
    overview: ["Track the screens of your Android app, and give each install a device id."],
    plans: ["A Kotlin library.", "Track the screens in your client settings."],
    clientSettings: true,
  },
  {
    slug: "nodejs",
    name: "Node.js",
    kind: "server",
    logo: nodejs,
    note: "Track events, ask for decisions and send labels from your server.",
    overview: [
      "The Kairos client for Node.js 18 or later, and any runtime with a global fetch. It sends events in batches in the background, and waits only for a decision.",
    ],
    docs: "/docs/reference/clients/typescript",
    steps: [
      npmStep,
      envStep,
      {
        title: "Send events and ask for a decision",
        code: (_, origin) => `import { Kairos } from "@finic-ai/kairos";

const kairos = ${tsClient(origin)};

kairos.track("login", { userId: "user_123", deviceId: "dev_9" });

const decision = await kairos.decide(
  { type: "bank_transfer", userId: "user_123", amount: 9500, currency: "USD" },
  { fallback: "review" },
);`,
      },
    ],
  },
  {
    slug: "express",
    name: "Express",
    kind: "server",
    logo: express,
    mono: true,
    note: "Middleware that adds the user, device and session of each request, and sends events for routes.",
    overview: [
      "With the middleware, a track or decide call anywhere in a request gets the user, the device, the IP address and the session from the request. The routes in your client settings send an event when the response finishes, or ask for a decision before your handler runs.",
    ],
    docs: "/docs/reference/clients/typescript#routes-from-the-console",
    clientSettings: true,
    steps: [
      npmStep,
      middlewareEnvStep,
      {
        title: "Add the middleware after your body parsers",
        code: (_, origin) => `import express, { type Request } from "express";
import { Kairos } from "@finic-ai/kairos";
import { express as kairosExpress } from "@finic-ai/kairos/middleware";

const kairos = ${tsClient(origin)};
const app = express();
app.use(express.json());

app.use(
  kairosExpress<Request>(kairos, {
    entities: (req) => ({ user: req.user?.id, device: req.get("x-kairos-device"), ip: req.ip }),
    session: (req) => req.session?.id,
    clientSettings: true,
    hashKey: process.env.KAIROS_HASH_KEY,
  }),
);`,
      },
    ],
  },
  {
    slug: "hono",
    name: "Hono",
    kind: "server",
    logo: hono,
    note: "Middleware for Hono on Node.js, Bun, Deno and Cloudflare Workers.",
    overview: [
      "The same middleware as for Express. On Cloudflare Workers, turn on nodejs_compat, and give the upload of route events to waitUntil.",
    ],
    docs: "/docs/reference/clients/typescript#routes-from-the-console",
    clientSettings: true,
    steps: [
      npmStep,
      middlewareEnvStep,
      {
        title: "Add the middleware",
        code: (_, origin) => `import { Hono, type Context } from "hono";
import { Kairos } from "@finic-ai/kairos";
import { hono as kairosHono, type KairosVariables } from "@finic-ai/kairos/middleware";

const kairos = ${tsClient(origin)};
type Env = { Variables: KairosVariables & { userId?: string; sessionId?: string } };
const app = new Hono<Env>();

app.use(
  kairosHono<Context<Env>>(kairos, {
    entities: (c) => ({ user: c.get("userId"), device: c.req.header("x-kairos-device") }),
    session: (c) => c.get("sessionId"),
    clientSettings: true,
    hashKey: process.env.KAIROS_HASH_KEY,
  }),
);`,
      },
    ],
  },
  {
    slug: "python",
    name: "Python",
    kind: "server",
    logo: python,
    note: "Track events and ask for decisions from Python.",
    overview: [
      "The Kairos client for Python 3.9 or later, with no dependencies. It is safe to use from several threads, and sends events in batches in the background.",
    ],
    docs: "/docs/reference/clients/python",
    steps: [
      { title: "Install", code: () => "pip install finic-kairos" },
      envStep,
      {
        title: "Send events and ask for a decision",
        code: (_, origin) => `import os
from kairos import Kairos

kairos = ${pyClient(origin)}

kairos.track("login", {"user_id": "user_123", "device_id": "dev_9"})

decision = kairos.decide("bank_transfer", {"user_id": "user_123", "usd": 9500}, fallback="review")`,
      },
    ],
  },
  {
    slug: "fastapi",
    name: "FastAPI",
    kind: "server",
    logo: fastapi,
    note: "Middleware for FastAPI, Starlette and any other ASGI framework.",
    overview: [
      "With KairosASGI, a track or decide call anywhere in a request gets the user, the IP address and the session from the request. The routes in your client settings send an event when the response finishes, or ask for a decision before your app runs.",
    ],
    docs: "/docs/reference/clients/python#routes-from-the-console",
    clientSettings: true,
    steps: [
      { title: "Install", code: () => "pip install finic-kairos" },
      middlewareEnvStep,
      {
        title: "Add the middleware",
        code: (_, origin) => `import os
from kairos import Kairos
from kairos.middleware import KairosASGI

kairos = ${pyClient(origin)}

app.add_middleware(
    KairosASGI,
    client=kairos,
    entities=lambda scope: {"user": scope["state"].get("user_id"), "ip": scope["client"][0]},
    session=lambda scope: scope["state"].get("session_id"),
    client_settings=True,
    hash_key=os.environ["KAIROS_HASH_KEY"],
)`,
      },
    ],
  },
  {
    slug: "rest-api",
    name: "REST API",
    kind: "server",
    logo: api,
    note: "Call Kairos over HTTP from any language.",
    overview: ["Every SDK uses this API. Send a secret key as a bearer token."],
    docs: "/docs/reference/api",
    steps: [
      {
        title: "Send an event",
        code: (key, origin) => `curl -X POST ${origin}/v1/events \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"batch":[{"id":"evt_01","type":"login","ts":"${new Date().toISOString()}","entities":{"user":"user_123"}}]}'`,
      },
    ],
  },
  {
    slug: "cloudflare",
    name: "Cloudflare Workers",
    kind: "edge",
    logo: cloudflare,
    note: "Send events for the routes in your client settings, and block them, with no change to your app.",
    overview: [
      "A Cloudflare Worker in front of your app. For each route in your client settings, it sends the route's event, or asks Kairos to decide before the request reaches your app or before the response reaches the person. Every other request goes on as it came, and an error of the Worker sends the request on.",
      "With a public key as KAIROS_PUBLIC_KEY, it also adds the website script to your pages. Behind it, the Express, Hono and FastAPI middleware send the events of a route themselves, with the user, and take the Worker's decision.",
    ],
    docs: "/docs/reference/clients/edge",
    clientSettings: true,
    steps: [
      { title: "Install, in a Worker project", code: () => "npm install @finic-ai/kairos-edge" },
      {
        title: "Put Kairos in front of your app",
        code: () => `// src/index.ts
import { cloudflare } from "@finic-ai/kairos-edge/cloudflare";

export default cloudflare();`,
      },
      {
        title: "Route the Worker on your domain",
        code: (_, origin) => `# wrangler.toml
name = "kairos"
main = "src/index.ts"
compatibility_date = "2025-09-01"
routes = [{ pattern = "example.com/*", zone_name = "example.com" }]${origin === HOSTED ? "" : `\n\n[vars]\nKAIROS_URL = "${origin}"`}`,
      },
      {
        title: "Add your secret key, and your servers' hash key, then deploy",
        code: (key) => `npx wrangler secret put KAIROS_API_KEY   # ${key}
npx wrangler secret put KAIROS_HASH_KEY  # the same as your servers'
npx wrangler deploy`,
      },
    ],
  },
  {
    slug: "fastly",
    name: "Fastly Compute",
    kind: "edge",
    logo: fastly,
    note: "The same as Cloudflare, on Fastly's edge.",
    overview: ["The same as the Cloudflare Worker, for Fastly Compute."],
    plans: ["The routes in your client settings, with the same modes as Cloudflare.", "A backend named kairos."],
    clientSettings: true,
  },
  {
    slug: "lambda-edge",
    name: "AWS Lambda@Edge",
    kind: "edge",
    logo: lambda,
    note: "The same as Cloudflare, on CloudFront.",
    overview: [
      "The same as the Cloudflare Worker, for CloudFront, with one function on the origin request and one on the origin response.",
    ],
    plans: [
      "The routes in your client settings, with the same modes as Cloudflare.",
      "A time limit of 5 seconds, set by AWS.",
    ],
    clientSettings: true,
  },
];
