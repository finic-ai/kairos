import type { z } from "zod";
import type { clientSettingsBody } from "./schema";

export const CONSENT = ["required", "not_required"] as const;
export const ROUTE_MODES = ["track", "decide_request", "decide_response"] as const;
/**
 * For the edge and the middleware together. Off sends nothing for routes; monitor tracks and decides but never
 * acts; active lets routes with `enforce` act. The middleware cannot run `decide_response`, which is the edge's.
 */
export const ROUTING_MODES = ["off", "monitor", "active"] as const;
/** What is done with a request that matches no route: nothing, or send the shape of its body. */
export const OTHER_REQUESTS = ["ignore", "discover"] as const;
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const FIELD_SOURCES = [
  "request.body",
  "request.query",
  "request.header",
  "request.cookie",
  "request.param",
  "response.header",
  "response.body",
] as const;
export const FIELD_KINDS = ["email", "phone", "address", "username", "hmac", "token"] as const;
/** The kinds of personal data that `defaults.off` can turn off in every client. */
export const DATA_KINDS = ["email", "phone", "address", "username"] as const;

export type ClientSettingsInput = z.output<typeof clientSettingsBody>;
export type ClientSettings = ClientSettingsInput & { version: number };

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = {
  version: 0,
  consent: "not_required",
  defaults: { off: [] },
  routing: { mode: "monitor", other: "ignore" },
  pages: [],
  screens: [],
  routes: [],
};
