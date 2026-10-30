import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { error, type Env } from "../http";
import type { SessionsService } from "../../services/session.service";
import type { User } from "../../types";

export const SESSION_COOKIE = "kairos_session";

export const sessionUser = (c: Context, sessions: SessionsService, now: Date) =>
  sessions.findUser(getCookie(c, SESSION_COOKIE), now);

/** Sign the person in on this browser. `trustProxy`: a proxy in front ends TLS and says so in X-Forwarded-Proto. */
export async function startSession(
  c: Context,
  sessions: SessionsService,
  user: User,
  now: Date,
  trustProxy = false,
): Promise<void> {
  const session = await sessions.start(user.id, now);
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    expires: session.expires,
    secure:
      new URL(c.req.url).protocol === "https:" ||
      (trustProxy && c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https"),
  });
}

export const requireSession =
  (sessions: SessionsService, now: () => Date): MiddlewareHandler<Env> =>
  async (c, next) => {
    const user = await sessionUser(c, sessions, now());
    if (!user) return error(c, 401, "not_signed_in", "Not signed in");
    c.set("user", user);
    await next();
  };
