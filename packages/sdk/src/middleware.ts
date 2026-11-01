import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import type { Kairos, RequestClient } from "./client.js";
import type { ContextValues, Id, Scope } from "./context.js";
import { KairosError } from "./errors.js";
import {
  EDGE_HEADER,
  TRACKED_HEADER,
  answerResponse,
  currentSettings,
  decideRoute,
  liveRoute,
  readCookie,
  readableBody,
  requestCookies,
  routing,
  trackAfter,
  verifyEdge,
  type Live,
  type RequestParts,
  type Routing,
} from "./routes.js";
import type { Decision } from "./types.js";

export type { ContextValues, Id } from "./context.js";
export type { RequestClient } from "./client.js";

/** The event a route sends when its response finishes. */
export interface RouteEvent<Req> {
  /** The event type for a response with a status below 400. */
  type: string;
  /** The event type for a 4xx response. Without it, a refused request sends nothing. */
  failed?: string;
  /**
   * Properties of the event. This is the only way business data gets onto the event of a
   * route: a route does not read the request body. A key that ends in `Id` names an entity.
   */
  properties?: (req: Req) => Record<string, unknown>;
}

export interface ContextOptions<Req> {
  /**
   * Who makes the request, as entity type → id. Called when an event or a decision needs it,
   * not when the request arrives, so it sees what your sign-in put on the request.
   */
  entities?: (req: Req) => Record<string, Id>;
  /** The id of the login session in your own system. Take it from your server, not from the browser. */
  session?: (req: Req) => Id;
  /**
   * The entity type of the person who makes the request. Default "user". A call that names
   * someone else of this type takes nothing from the request.
   */
  subject?: string;
  /**
   * "METHOD /pattern" → the event to send when the response finishes: `"POST /payees": "beneficiary_added"`.
   * The pattern is the route as you registered it (`/payees/:id`), with the path of its router.
   */
  routes?: Record<string, string | RouteEvent<Req>>;
  /**
   * Receives the upload of an automatic event. In a serverless function, hand it to the
   * platform, or the function can stop before the event is sent.
   */
  waitUntil?: (req: Req, work: Promise<void>) => void;
  /**
   * Also run the routes of the client settings of the key's environment (Settings › Integrations).
   * They are read in the background, and again each minute; a request never waits for them. A route
   * that decides on the request is decided before your handler runs. Needs a secret key.
   */
  clientSettings?: boolean;
  /** The secret for fields and session cookies that are sent only as a hash. The same on every server. */
  hashKey?: string;
}

interface RequestScope extends Scope {
  /** What `setContext` gave. It wins over the resolvers. */
  given: ContextValues;
}

const stores = new WeakMap<Kairos, AsyncLocalStorage<RequestScope | undefined>>();

/** One store for each client, so that two clients in a process do not read each other's requests. */
function storeOf(kairos: Kairos): AsyncLocalStorage<RequestScope | undefined> {
  let store = stores.get(kairos);
  if (!store) {
    store = new AsyncLocalStorage<RequestScope | undefined>();
    stores.set(kairos, store);
    const found = store;
    kairos.scopeSource = () => found.getStore();
  }
  return store;
}

function newScope(subject: string | undefined, resolve: () => ContextValues): RequestScope {
  const given: ContextValues = {};
  return {
    subject: subject ?? "user",
    tracked: new Set(),
    given,
    resolve: () => {
      const found = resolve();
      return { entities: { ...found.entities, ...given.entities }, session: given.session ?? found.session };
    },
  };
}

/** What the cookies of a request say about who is acting. */
type Cookies = { device?: string; session?: string; visit?: string };

const requestScope = <Req>(options: ContextOptions<Req>, req: Req, cookies: () => Cookies) =>
  newScope(options.subject, () => {
    const entities = options.entities?.(req);
    const known = cookies();
    return {
      entities: { ...entities, device: entities?.device || known.device },
      session: options.session?.(req) ?? known.session ?? known.visit,
    };
  });

/**
 * Say who is acting, from inside a request: for a sign-in handler, which learns the user and
 * makes the session itself. The values win over the resolvers for the rest of the request.
 */
export function setContext(kairos: Kairos, values: ContextValues): void {
  const scope = storeOf(kairos).getStore();
  if (!scope)
    throw new KairosError("setContext was called outside a request. Use runWithContext for work that has no request.");
  scope.given.entities = { ...scope.given.entities, ...values.entities };
  if (values.session !== undefined) scope.given.session = values.session;
}

/** Run `fn` with a context and no HTTP request: a queue worker, a scheduled job, a test. */
export function runWithContext<T>(kairos: Kairos, values: ContextValues & { subject?: string }, fn: () => T): T {
  return storeOf(kairos).run(
    newScope(values.subject, () => values),
    fn,
  );
}

/** Run `fn` with no context, for work inside a request that is about other people. */
export function withoutContext<T>(kairos: Kairos, fn: () => T): T {
  return storeOf(kairos).run(undefined, fn);
}

const trimmed = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path) || "/";

type Routes<Req> = Map<string, RouteEvent<Req>>;

function routesOf<Req>(routes: ContextOptions<Req>["routes"]): Routes<Req> {
  const out: Routes<Req> = new Map();
  for (const [key, value] of Object.entries(routes ?? {})) {
    const match = /^([A-Za-z]+)\s+(\/.*)$/.exec(key.trim());
    if (!match)
      throw new KairosError(`routes: "${key}" must be a method and a route pattern, such as "POST /payees/:id"`);
    const event = typeof value === "string" ? { type: value } : value;
    if (!event.type) throw new KairosError(`routes: "${key}" needs an event type`);
    out.set(`${match[1]!.toUpperCase()} ${trimmed(match[2]!)}`, event);
  }
  return out;
}

type Bound = ReturnType<Kairos["bind"]>;

/** Send the event of the route, if the route has one for this status. */
function finished<Req>(
  kairos: Kairos,
  options: ContextOptions<Req>,
  routes: Routes<Req>,
  auto: Bound["auto"],
  req: Req,
  method: string,
  pattern: string | undefined,
  status: number,
): void {
  if (pattern === undefined) return;
  const route = trimmed(pattern);
  const event = routes.get(`${method.toUpperCase()} ${route}`);
  // A 5xx is a fault of the server, not something the person did.
  const type = !event ? undefined : status < 400 ? event.type : status < 500 ? event.failed : undefined;
  if (!type) return;
  // Not `method`, `status` or a name that ends in `id`: those mean other things on an event.
  const queued = auto(type, () => ({
    ...event!.properties?.(req),
    source: "auto",
    http_method: method.toUpperCase(),
    http_route: route,
    http_status: String(status),
  }));
  if (queued) options.waitUntil?.(req, kairos.flush());
}

/** The scope reads the session cookie's hash as it resolves, which cannot wait. */
type Side = Routing & { hash?: (value: string) => string };

function sideOf(
  kairos: Kairos,
  options: Pick<ContextOptions<unknown>, "clientSettings" | "hashKey">,
): Side | undefined {
  if (!options.clientSettings) return undefined;
  currentSettings(kairos);
  const { hashKey } = options;
  const hash = hashKey ? (value: string) => createHmac("sha256", hashKey).update(value).digest("hex") : undefined;
  return { ...routing(kairos, hash), hash };
}

function forRequest(
  side: Side | undefined,
  method: string,
  path: string,
): { live?: Live; cookies(header: string | undefined): Cookies } {
  if (!side) return { cookies: () => ({}) };
  const settings = currentSettings(side.kairos);
  const live = liveRoute(side, settings, method, path);
  return {
    cookies: (header) => requestCookies(settings, header, side.hash),
    // The middleware cannot hold back a response once a handler wrote it: that route is the edge's.
    live: live?.route.mode === "decide_response" ? undefined : live,
  };
}

async function fromEdge(
  live: Live,
  header: string | undefined,
  path: string,
): Promise<{ decision?: Decision } | undefined> {
  if (!header) return undefined;
  if (!live.hash) {
    live.report("A request came from the Kairos edge, and there is no hashKey to check its x-kairos-edge header.");
    return undefined;
  }
  return verifyEdge(live.hash, header, { method: live.method, path });
}

/** A query parameter or a header as one text: the first, when there are several. */
function text(value: unknown): string | undefined {
  if (Array.isArray(value)) return text(value[0]);
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The Kairos client with the context of this request. Set by the Kairos middleware. */
      kairos: RequestClient;
      /** The decision of a route of the client settings that decides on the request. */
      kairosDecision?: Decision;
    }
  }
}

/** As much of an Express request and response as the middleware reads. */
interface ExpressRequest {
  method: string;
  originalUrl: string;
  baseUrl?: string;
  route?: { path?: unknown };
  body?: unknown;
  query?: unknown;
  get(name: string): string | undefined;
  kairos?: RequestClient;
  kairosDecision?: Decision;
}
interface ExpressResponse {
  statusCode: number;
  once(event: "finish", listener: () => void): unknown;
  getHeader(name: string): unknown;
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
  redirect(status: number, url: string): unknown;
}

/**
 * Express middleware. Inside a request, `track` and `decide` take the entities and the session
 * from it, and the routes in `routes` send an event when they finish.
 *
 *     app.use(express(kairos, { entities: (req) => ({ user: req.user?.id }), session: (req) => req.session?.id }));
 *
 * Install it after the body parsers: some older middleware loses the context of the request.
 * `req.kairos` holds the context directly and does not depend on it.
 */
export function express<Req extends ExpressRequest = ExpressRequest>(
  kairos: Kairos,
  options: ContextOptions<Req> = {},
): (req: Req, res: ExpressResponse, next: () => void) => void {
  const store = storeOf(kairos);
  const routes = routesOf(options.routes);
  const side = sideOf(kairos, options);
  return (req, res, next) => {
    const path = req.originalUrl.split("?")[0]!;
    const { live, cookies } = forRequest(side, req.method, path);
    const scope = requestScope(options, req, () => cookies(req.get("cookie")));
    const { auto, autoDecide, ...client } = kairos.bind(scope);
    req.kairos = client;
    let answered = false;
    const parts = (params: Record<string, string>): RequestParts => ({
      body: readableBody(req.get("content-type"), req.get("content-length")) ? req.body : undefined,
      query: (name) => text((req.query as Record<string, unknown> | undefined)?.[name]),
      header: (name) => req.get(name),
      cookie: (name) => readCookie(req.get("cookie"), name),
      params,
      responseHeader: (name) => text(res.getHeader(name)),
    });
    if (routes.size > 0 || live) {
      // Only a response that was sent: a request the client gave up on fires "close" alone.
      res.once("finish", () => {
        const path = req.route?.path;
        finished(
          kairos,
          options,
          routes,
          auto,
          req,
          req.method,
          typeof path === "string" ? (req.baseUrl ?? "") + path : undefined,
          res.statusCode,
        );
        // The middleware's own block response is not something the person's request was refused for.
        const work =
          live && !answered && store.run(scope, () => trackAfter(live, parts(live.params), auto, res.statusCode));
        if (work) options.waitUntil?.(req, work);
      });
    }
    const header = req.get(EDGE_HEADER);
    store.run(scope, () => {
      if (!live || (!header && live.route.mode !== "decide_request")) return next();
      void (async () => {
        const edge = await fromEdge(live, header, path);
        if (edge) res.setHeader(TRACKED_HEADER, "1");
        if (live.route.mode !== "decide_request") return next();
        if (edge?.decision) {
          req.kairosDecision = edge.decision;
          return next();
        }
        const { decision, answer } = await decideRoute(live, parts(live.params), autoDecide);
        if (decision) req.kairosDecision = decision;
        if (!answer) return next();
        answered = true;
        if ("redirect" in answer) res.redirect(302, answer.redirect);
        else res.status(answer.status).json(answer.body);
      })();
    });
  };
}

/** As much of a Hono context as the middleware reads. */
interface HonoContext {
  req: {
    method: string;
    url: string;
    path: string;
    routePath?: string;
    routeIndex?: number;
    header(name: string): string | undefined;
    query(name: string): string | undefined;
    json(): Promise<unknown>;
  };
  res: { status: number; headers: Headers };
  header(name: string, value: string): void;
  set(key: "kairos", value: RequestClient): void;
  set(key: "kairosDecision", value: Decision): void;
}

/** For `new Hono<{ Variables: KairosVariables }>()`, so that `c.get("kairos")` has a type. */
export type KairosVariables = { kairos: RequestClient; kairosDecision?: Decision };

/**
 * Hono middleware. The resolvers receive the Hono context.
 *
 *     app.use(hono(kairos, { entities: (c) => ({ user: c.get("user")?.id }), session: (c) => c.get("sessionId") }));
 *
 * `c.get("kairos")` holds the context of the request directly.
 */
export function hono<Ctx extends HonoContext = HonoContext>(
  kairos: Kairos,
  options: ContextOptions<Ctx> = {},
): (c: Ctx, next: () => Promise<void>) => Promise<Response | void> {
  const store = storeOf(kairos);
  const routes = routesOf(options.routes);
  const side = sideOf(kairos, options);
  return async (c, next) => {
    const { live, cookies } = forRequest(side, c.req.method, c.req.path);
    const scope = requestScope(options, c, () => cookies(c.req.header("cookie")));
    const { auto, autoDecide, ...client } = kairos.bind(scope);
    c.set("kairos", client);
    const own = c.req.routeIndex;
    // Read before the handler, which may read the body too: Hono keeps it for a second reader.
    // Only with a length: Hono reads a body of unknown length to its end, however large.
    const length = c.req.header("content-length");
    const body =
      live &&
      length !== undefined &&
      readableBody(c.req.header("content-type"), length) &&
      Object.values(live.route.fields).some((f) => f.from === "request.body")
        ? await c.req.json().catch(() => undefined)
        : undefined;
    const parts = (params: Record<string, string>): RequestParts => ({
      body,
      query: (name) => c.req.query(name),
      header: (name) => c.req.header(name),
      cookie: (name) => readCookie(c.req.header("cookie"), name),
      params,
      responseHeader: (name) => c.res.headers.get(name) ?? undefined,
    });

    // The path as the edge signed it: `c.req.path` is decoded.
    const edge = live && (await fromEdge(live, c.req.header(EDGE_HEADER), new URL(c.req.url).pathname));
    if (live?.route.mode === "decide_request") {
      if (edge?.decision) c.set("kairosDecision", edge.decision);
      else {
        const { decision, answer } = await store.run(scope, () => decideRoute(live, parts(live.params), autoDecide));
        if (decision) c.set("kairosDecision", decision);
        if (answer) return answerResponse(answer);
      }
    }

    await store.run(scope, next);
    if (edge) c.header(TRACKED_HEADER, "1");
    // With no handler after this middleware, the pattern is the middleware's own.
    if (routes.size > 0 && (own === undefined || c.req.routeIndex !== own))
      finished(kairos, options, routes, auto, c, c.req.method, c.req.routePath, c.res.status);
    const work = live && store.run(scope, () => trackAfter(live, parts(live.params), auto, c.res.status));
    if (work) options.waitUntil?.(c, work);
  };
}
