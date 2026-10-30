import { KairosError } from "./errors.js";

/** An id as a resolver can give it. An empty value is no id. */
export type Id = string | number | null | undefined;

/** What a request says about who is acting. */
export interface ContextValues {
  /** Entity type → id: `{ user: "user_42", device: "dev_9", ip: "203.0.113.7" }`. */
  entities?: Record<string, Id>;
  /** The visit the request is part of. See `$session`. */
  session?: Id;
}

/**
 * The context of one request, as the client reads it. `@finic-ai/kairos/middleware` makes one for
 * each request; nothing here needs Node.js.
 */
export interface Scope {
  /** The entity type of the person who makes the request, for example "user". */
  subject: string;
  /** The event types tracked in this request, so that an automatic event does not repeat one. */
  tracked: Set<string>;
  /** Who is acting, as known at this moment. Called late, because sign-in runs after the middleware. */
  resolve(): ContextValues;
}

/** The entities of a scope in the form the API takes. Empty values are left out. */
export function scopeEntities(values: ContextValues): Record<string, string> {
  const entities: Record<string, string> = {};
  for (const [type, id] of Object.entries(values.entities ?? {})) {
    if (id === undefined || id === null || id === "") continue;
    if (typeof id !== "string" && typeof id !== "number")
      throw new KairosError(`The context gave a ${typeof id} as the id of "${type}". An id is text or a number.`);
    entities[type] = String(id);
  }
  return entities;
}
