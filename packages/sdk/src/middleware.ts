import { AsyncLocalStorage } from "node:async_hooks";
import type { Kairos, RequestClient } from "./client.js";
import type { ContextValues, Id, Scope } from "./context.js";
import { KairosError } from "./errors.js";

export type { ContextValues, Id } from "./context.js";
export type { RequestClient } from "./client.js";

/** The event a route sends when its response finishes. */
export interface RouteEvent<Req> {
  /** The event type for a response with a status below 400. */
  type: string;
  /** The event type for a 4xx response. Without it, a refused request sends nothing. */
  failed?: string;
  /**
   * Properties of the event. This is the only way business data gets onto an automatic event:
   * the middleware does not read the request body. A key that ends in `Id` names an entity.
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

const requestScope = <Req>(options: ContextOptions<Req>, req: Req) =>
  newScope(options.subject, () => ({ entities: options.entities?.(req), session: options.session?.(req) }));

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

/** Send the event of the route, if the route has one for this status. */
function finished<Req>(
  kairos: Kairos,
  options: ContextOptions<Req>,
  routes: Routes<Req>,
  auto: (type: string, properties: () => Record<string, unknown>) => boolean,
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

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The Kairos client with the context of this request. Set by the Kairos middleware. */
      kairos: RequestClient;
    }
  }
}

/** As much of an Express request and response as the middleware reads. */
interface ExpressRequest {
  method: string;
  baseUrl?: string;
  route?: { path?: unknown };
  kairos?: RequestClient;
}
interface ExpressResponse {
  statusCode: number;
  once(event: "finish", listener: () => void): unknown;
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
  return (req, res, next) => {
    const scope = requestScope(options, req);
    const { auto, ...client } = kairos.bind(scope);
    req.kairos = client;
    if (routes.size > 0) {
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
      });
    }
    store.run(scope, next);
  };
}

/** As much of a Hono context as the middleware reads. */
interface HonoContext {
  req: { method: string; routePath?: string; routeIndex?: number };
  res: { status: number };
  set(key: "kairos", value: RequestClient): void;
}

/** For `new Hono<{ Variables: KairosVariables }>()`, so that `c.get("kairos")` has a type. */
export type KairosVariables = { kairos: RequestClient };

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
): (c: Ctx, next: () => Promise<void>) => Promise<void> {
  const store = storeOf(kairos);
  const routes = routesOf(options.routes);
  return async (c, next) => {
    const scope = requestScope(options, c);
    const { auto, ...client } = kairos.bind(scope);
    c.set("kairos", client);
    const own = c.req.routeIndex;
    await store.run(scope, next);
    // With no handler after this middleware, the pattern is the middleware's own.
    if (routes.size > 0 && (own === undefined || c.req.routeIndex !== own))
      finished(kairos, options, routes, auto, c, c.req.method, c.req.routePath, c.res.status);
  };
}
