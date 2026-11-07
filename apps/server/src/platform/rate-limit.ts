import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { Limit, RateLimitsService } from "../services/rate_limit.service";
import { rateLimited, type Env } from "./http";

export const rateLimit =
  (limiter: RateLimitsService, now: () => Date, limitsOf: (c: Context<Env>) => Limit[]): MiddlewareHandler<Env> =>
  async (c, next) => {
    const limits = limitsOf(c);
    if (limits.length) {
      const wait = await limiter.hit(limits, now());
      if (wait > 0) return rateLimited(c, wait);
    }
    await next();
  };

/** The pattern of the route that will answer, also from `app.use`: middleware is registered as `ALL`. */
export function routeOf(c: Context): string {
  const route = [...matchedRoutes(c)].reverse().find((r) => r.method !== "ALL");
  return `${c.req.method} ${route?.path ?? "(no route)"}`;
}
