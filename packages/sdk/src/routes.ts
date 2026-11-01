import { DEVICE_COOKIE, VISIT_COOKIE, readCookie } from "@finic-ai/kairosid";
import type { Kairos } from "./client.js";
import { KairosError } from "./errors.js";
import { matchRoute, routeProperties, type Hash, type RequestParts } from "./settings.js";
import type { Action, ClientRoute, ClientSettings, Decision, DecideOptions, EventProperties } from "./types.js";

export { DEVICE_COOKIE, VISIT_COOKIE, readCookie } from "@finic-ai/kairosid";
export { MAX_BODY_BYTES, readableBody, type Hash, type RequestParts } from "./settings.js";

/** On a request that the edge sent on: what it did with the route, signed with the hash key. */
export const EDGE_HEADER = "x-kairos-edge";
/** On a response to the edge: the middleware sends the events of the route, so the edge does not. */
export const TRACKED_HEADER = "x-kairos-tracked";

const REFRESH_MS = 60_000;
const EDGE_MAX_AGE_MS = 5 * 60_000;
const loaded = new WeakMap<Kairos, { settings?: ClientSettings; at: number; loading?: Promise<void> }>();

export function currentSettings(kairos: Kairos, waitUntil?: (work: Promise<void>) => void): ClientSettings | undefined {
  const held = loaded.get(kairos) ?? { at: -Infinity };
  loaded.set(kairos, held);
  if (!held.loading && Date.now() - held.at >= REFRESH_MS) {
    held.loading = kairos
      .clientSettings()
      .then(
        (settings) => void (held.settings = settings),
        (cause) => kairos.report(cause),
      )
      .finally(() => {
        held.at = Date.now();
        held.loading = undefined;
      });
    waitUntil?.(held.loading);
  }
  return held.settings;
}

export interface Routing {
  kairos: Kairos;
  hash?: Hash;
  report(problem: string): void;
}

export function routing(kairos: Kairos, hash?: Hash): Routing {
  const reported = new Set<string>();
  return {
    kairos,
    hash,
    report: (problem) => {
      if (reported.has(problem)) return;
      reported.add(problem);
      kairos.report(new KairosError(problem));
    },
  };
}

export interface Live extends Routing {
  settings: ClientSettings;
  route: ClientRoute;
  params: Record<string, string>;
  method: string;
}

export function liveRoute(
  on: Routing,
  settings: ClientSettings | undefined,
  method: string,
  path: string,
): Live | undefined {
  const matched = settings && matchRoute(settings, method, path);
  return matched ? { ...on, settings: settings!, method, ...matched } : undefined;
}

export function requestCookies<T>(
  settings: ClientSettings | undefined,
  header: string | undefined,
  hash: ((value: string) => T) | undefined,
): { device?: string; visit?: string; session?: T } {
  const name = settings?.defaults.sessionCookie;
  const session = name ? readCookie(header, name) : undefined;
  return {
    device: readCookie(header, DEVICE_COOKIE),
    visit: readCookie(header, VISIT_COOKIE),
    session: session && hash ? hash(session) : undefined,
  };
}

const routeFacts = (live: Live) => ({
  source: "auto",
  http_method: live.method.toUpperCase(),
  http_route: live.route.route.slice(live.route.route.indexOf(" ") + 1),
});

async function propertiesOf(live: Live, parts: RequestParts, facts: EventProperties): Promise<EventProperties> {
  const { properties, problems } = await routeProperties(live.route, parts, live.settings, live.hash);
  problems.forEach(live.report);
  return { ...facts, ...properties, ...routeFacts(live) };
}

export type Answer = { status: number; body: unknown } | { redirect: string };

type AutoDecide = (
  type: string,
  properties: () => EventProperties,
  options: Omit<DecideOptions, "timestamp"> & { fallback: Action },
) => Promise<Decision | undefined>;
type Auto = (type: string, properties: () => EventProperties) => boolean;

export async function decideRoute(
  live: Live,
  parts: RequestParts,
  autoDecide: AutoDecide,
  facts: EventProperties = {},
): Promise<{ decision?: Decision; answer?: Answer }> {
  const { route, settings } = live;
  try {
    const properties = await propertiesOf(live, parts, facts);
    const decision = await autoDecide(route.type, () => properties, {
      fallback: route.fallback ?? "approve",
      ...(route.timeoutMs ? { timeoutMs: route.timeoutMs } : {}),
    });
    if (!decision || !route.enforce || settings.routing.mode !== "active") return { decision };
    if (decision.decision === "block")
      return {
        decision,
        answer: { status: route.block?.status ?? 403, body: route.block?.body ?? { error: "blocked" } },
      };
    if (decision.decision === "step_up" && route.stepUp && route.stepUp !== "forward")
      return { decision, answer: { redirect: route.stepUp.redirect } };
    return { decision };
  } catch (cause) {
    live.kairos.report(cause);
    return {};
  }
}

export function trackAfter(
  live: Live,
  parts: RequestParts,
  auto: Auto,
  status: number,
  facts: EventProperties = {},
): Promise<void> | undefined {
  const { route } = live;
  const type =
    status >= 500 ? undefined : status >= 400 ? route.failed : route.mode === "track" ? route.type : undefined;
  if (!type) return undefined;
  return propertiesOf(live, parts, facts)
    .then((properties) => {
      if (auto(type, () => ({ ...properties, http_status: String(status) }))) return live.kairos.flush();
    })
    .catch((cause) => live.kairos.report(cause));
}

export function answerResponse(answer: Answer): Response {
  return "redirect" in answer
    ? new Response(null, { status: 302, headers: { location: answer.redirect } })
    : new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
}

const base64url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unbase64url = (text: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)),
  );

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signEdge(
  hash: Hash,
  request: { method: string; path: string; decision?: Decision },
  now = Date.now(),
): Promise<string> {
  const { decision } = request;
  const payload = base64url(
    JSON.stringify({
      t: now,
      m: request.method.toUpperCase(),
      p: request.path,
      // Not the reasons or rules: they can be long, and a request's headers have a size limit.
      ...(decision
        ? {
            d: {
              decision: decision.decision,
              risk_score: decision.riskScore,
              probability: decision.probability,
              ...(decision.decisionId ? { decision_id: decision.decisionId } : {}),
              ...(decision.eventId ? { event_id: decision.eventId } : {}),
              ...(decision.fallback ? { fallback: true } : {}),
            },
          }
        : {}),
    }),
  );
  return `${payload}.${await hash(`kairos-edge.${payload}`)}`;
}

export async function verifyEdge(
  hash: Hash,
  header: string | undefined,
  request: { method: string; path: string },
  now = Date.now(),
): Promise<{ decision?: Decision } | undefined> {
  const [payload, signature, extra] = header?.split(".") ?? [];
  if (!payload || !signature || extra !== undefined) return undefined;
  if (!sameText(signature, await hash(`kairos-edge.${payload}`))) return undefined;
  let claim: { t?: number; m?: string; p?: string; d?: Record<string, any> };
  try {
    claim = JSON.parse(unbase64url(payload));
  } catch {
    return undefined;
  }
  if (typeof claim.t !== "number" || Math.abs(now - claim.t) > EDGE_MAX_AGE_MS) return undefined;
  if (claim.m !== request.method.toUpperCase() || claim.p !== request.path) return undefined;
  const d = claim.d;
  if (!d) return {};
  return {
    decision: {
      decision: d.decision,
      riskScore: d.risk_score,
      probability: d.probability,
      reasons: [],
      rules: [],
      ...(d.decision_id ? { decisionId: d.decision_id } : {}),
      ...(d.event_id ? { eventId: d.event_id } : {}),
      fallback: d.fallback === true,
    },
  };
}
