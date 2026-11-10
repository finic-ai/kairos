import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { normalizeEmail, hashPassword, newToken } from "../../platform/crypto";
import { error, parse, rateLimited, type Env } from "../../platform/http";
import { ipOf } from "../../platform/network";
import { SESSION_COOKIE, sessionUser, startSession } from "../../platform/auth";
import {
  accessTokenClaims,
  authorizeUrl,
  CognitoError,
  exchangeCode,
  logoutUrl,
  userApi,
  verifyIdToken,
  type CognitoConfig,
} from "../../platform/auth/cognito";
import {
  deleteAccountBody,
  loginBody,
  mfaCodeBody,
  passwordBody,
  profileBody,
  signupBody,
  supabaseBody,
} from "./schema";
import type { TenancyRepository } from "../../repositories";
import type { Environments } from "../environments/service";
import { LIMITS, type RateLimitsService } from "../../services/rate_limit.service";
import type { SessionsService } from "../../services/session.service";
import type { UsersService } from "../../services/user.service";
import type { WorkspacesService } from "../../services/workspace.service";
import { profile, setUpNewUser } from "./service";
import type { Provider, Strategy, User } from "../../types";

export interface AuthDeps {
  accounts: TenancyRepository;
  users: UsersService;
  rateLimits: RateLimitsService;
  sessions: SessionsService;
  workspaces: WorkspacesService;
  environments: Environments;
  now: () => Date;
  signup: boolean;
  supabase?: { url: string; anonKey: string; providers?: string[] };
  cognito?: CognitoConfig;
  trustProxy?: boolean;
  fetch: typeof fetch;
}

interface SupabaseUser {
  id?: string;
  email?: string;
  app_metadata?: { provider?: string };
  user_metadata?: { name?: string; full_name?: string; given_name?: string; family_name?: string };
}

/** A person as an outside provider names them, after the provider checked who they are. */
interface Identity {
  subject: string;
  email: string;
  strategy?: Strategy;
  displayName?: string;
  firstName?: string;
  lastName?: string;
}

/** The PKCE verifier, the state and the invite of a Cognito sign-in, kept while the person is at Cognito. */
const COGNITO_COOKIE = "kairos_cognito";
/**
 * The person's Cognito access token, for the two-factor routes only: Cognito changes a person's
 * second factor only with their own token. HttpOnly, sent to /auth/mfa alone, gone when the token is.
 */
const ACCESS_COOKIE = "kairos_cognito_access";
/** A change to two-factor authentication needs a sign-in this recent. */
const REAUTH_SECONDS = 10 * 60;

/**
 * A place in the console to come back to: a path on this site, never another site. Browsers drop
 * tabs and newlines from a URL, so "/\t/evil.example" would become "//evil.example".
 */
const safeNext = (next: string | undefined) => (next && /^\/(?![/\\])[^\s\\\p{Cc}]*$/u.test(next) ? next : undefined);

const strategyOf = (identity: SupabaseUser): Strategy | undefined =>
  identity.app_metadata?.provider === "google"
    ? "google"
    : identity.app_metadata?.provider === "email"
      ? "email_password"
      : undefined;

export function authRoutes({
  accounts,
  users,
  rateLimits,
  sessions,
  workspaces,
  environments,
  now,
  signup,
  supabase,
  cognito,
  trustProxy,
  fetch: doFetch,
}: AuthDeps) {
  const app = new Hono<Env>();

  const signedIn = (c: Context) => sessionUser(c, sessions, now());
  const notSignedIn = (c: Context, message = "Not signed in") => error(c, 401, "not_signed_in", message);
  const answer = async (c: Context, user: User) => c.json(await profile(accounts, users, environments, user));
  const joined = (c: Context<Env>, user: User, workspaceId: string) =>
    c.var.logActivity({
      workspaceId,
      environmentId: null,
      userId: user.id,
      action: "member.joined",
      resource: { type: "member", id: user.id },
    });

  const finishSignIn = async (c: Context<Env>, user: User, invite: string | undefined) => {
    if (invite) {
      const result = await accounts.acceptInvite(invite, user, now());
      if (!result.ok)
        return error(
          c,
          403,
          "invite_invalid",
          result.reason === "wrong_email"
            ? "This invite is for a different email address"
            : "This invite is not valid any more",
        );
      await joined(c, user, result.workspace_id);
    }
    await setUpNewUser(accounts, users, user, now());
    await startSession(c, sessions, user, now(), trustProxy);
    return answer(c, user);
  };

  // With Cognito, Cognito keeps the passwords and the second factors: Kairos keeps none.
  const password = !cognito;
  const passwordOff = (c: Context) => error(c, 404, "not_enabled", "Sign in with Cognito");

  /**
   * Signs in the person that Supabase or Cognito vouched for, and makes their account the first
   * time. An error is returned as data, because Cognito's answer is a redirect and not JSON.
   */
  const signInIdentity = async (
    provider: Exclude<Provider, "native">,
    identity: Identity,
    inviteToken: string | undefined,
  ): Promise<
    { user: User; invite?: string; joined?: string } | { status: 403 | 409; type: string; message: string }
  > => {
    const known = await users.findByIdentity(provider, identity.subject);
    if (known) {
      if (known.disabled) return { status: 403, type: "account_disabled", message: "This account is disabled" };
      const { disabled: _disabled, ...user } = known;
      if (identity.strategy) await users.setStrategy(user.id, provider, identity.strategy, now());
      const accepted = inviteToken ? await accounts.acceptInvite(inviteToken, user, now()) : null;
      return { user, ...(accepted?.ok ? { joined: accepted.workspace_id } : {}) };
    }
    // One way to sign in for each account: an address that signs in another way is not joined
    // to this one, because Kairos did not check that this person owns the address.
    const existing = await users.findByEmail(identity.email);
    if (existing)
      return {
        status: 409,
        type: "email_taken",
        message:
          (await users.providerOf(existing.id)) === "native"
            ? "Sign in with your password"
            : "This email address signs in another way. Use the way you signed in before.",
      };
    const invite = inviteToken ? await accounts.inviteByToken(inviteToken, now()) : null;
    if (!signup && !(invite && invite.email === normalizeEmail(identity.email)))
      return { status: 403, type: "signup_closed", message: "Sign-up is by invitation only" };
    const created = await users.createWithAuth(
      {
        email: identity.email,
        displayName: identity.displayName,
        firstName: identity.firstName,
        lastName: identity.lastName,
        auth: { provider, ...(identity.strategy ? { strategy: identity.strategy } : {}) },
        subjectId: identity.subject,
      },
      now(),
    );
    return { user: created, invite: invite ? inviteToken : undefined };
  };

  app.get("/config", (c) =>
    c.json({
      password,
      signup,
      supabase: supabase
        ? { url: supabase.url, anon_key: supabase.anonKey, providers: supabase.providers ?? [] }
        : null,
      cognito: cognito ? { providers: cognito.providers } : null,
    }),
  );

  app.post("/signup", async (c) => {
    if (!password) return passwordOff(c);
    const input = await parse(c, signupBody);
    if ("response" in input) return input.response;
    const wait = await rateLimits.hit(LIMITS.signup(ipOf(c, trustProxy)), now());
    if (wait > 0) return rateLimited(c, wait);
    const invite = input.data.invite ? await accounts.inviteByToken(input.data.invite, now()) : null;
    if (input.data.invite && !invite) return error(c, 403, "invite_invalid", "This invite is not valid any more");
    if (invite && invite.email !== input.data.email)
      return error(c, 403, "invite_invalid", "This invite is for a different email address");
    if (!signup && !invite) return error(c, 403, "signup_closed", "Sign-up is by invitation only");
    if (await users.findByEmail(input.data.email))
      return error(c, 409, "email_taken", "An account with this email address exists. Sign in instead.");
    const user = await users.createWithAuth(
      {
        email: input.data.email,
        displayName: input.data.name,
        auth: { provider: "native", strategy: "email_password" },
        passwordHash: await hashPassword(input.data.password),
      },
      now(),
    );
    return finishSignIn(c, user, input.data.invite);
  });

  app.post("/login", async (c) => {
    if (!password) return passwordOff(c);
    const input = await parse(c, loginBody);
    if ("response" in input) return input.response;
    const email = normalizeEmail(input.data.email);
    const ip = ipOf(c, trustProxy);
    const limits = LIMITS.login(email, ip);
    const wait = await rateLimits.hit(limits, now());
    if (wait > 0) return rateLimited(c, wait);
    // The same answer for an unknown address, a wrong password, and an account that signs in with Supabase.
    const user = await users.signInWithPassword(email, input.data.password);
    if (!user) return error(c, 401, "invalid_credentials", "The email address or the password is not correct");
    const [emailAndIp, ...others] = limits;
    await rateLimits.reset(emailAndIp!.key);
    for (const { key } of others) await rateLimits.undo(key);
    await startSession(c, sessions, user, now(), trustProxy);
    return answer(c, user);
  });

  // Supabase Auth, when it is configured: the browser signs in with Supabase and sends the
  // access token here. Supabase says who it belongs to, and a Kairos session starts.
  app.post("/supabase", async (c) => {
    if (!supabase) return error(c, 404, "not_enabled", "Supabase sign-in is not enabled");
    const input = await parse(c, supabaseBody);
    if ("response" in input) return input.response;
    let identity: SupabaseUser;
    try {
      const response = await doFetch(`${supabase.url.replace(/\/+$/, "")}/auth/v1/user`, {
        headers: { apikey: supabase.anonKey, Authorization: `Bearer ${input.data.access_token}` },
      });
      if (!response.ok) return error(c, 401, "invalid_credentials", "Supabase did not accept this sign-in");
      identity = (await response.json()) as SupabaseUser;
    } catch {
      return error(c, 502, "supabase_unavailable", "Supabase could not be reached");
    }
    if (!identity.id || !identity.email)
      return error(c, 401, "invalid_credentials", "Supabase did not return an email address");

    const meta = identity.user_metadata ?? {};
    const result = await signInIdentity(
      "supabase",
      {
        subject: identity.id,
        email: identity.email,
        strategy: strategyOf(identity),
        displayName: meta.full_name ?? meta.name,
        firstName: meta.given_name,
        lastName: meta.family_name,
      },
      input.data.invite,
    );
    if ("status" in result) return error(c, result.status, result.type, result.message);
    if (result.joined) await joined(c, result.user, result.joined);
    return finishSignIn(c, result.user, result.invite);
  });

  // Cognito, when it is configured. The console opens /auth/cognito/start, which sends the person
  // to the Cognito managed login page (or straight to a provider such as Google). Cognito sends
  // them back to /auth/cognito/callback with a code, and a Kairos session starts there.
  const secure = (c: Context) =>
    new URL(c.req.url).protocol === "https:" ||
    (!!trustProxy && c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https");
  // The console shows the message of a failed sign-in from the address.
  const backToConsole = (c: Context, problem?: string, next?: string) =>
    c.redirect(problem ? `/?${new URLSearchParams({ auth_error: problem })}` : (next ?? "/"));

  app.get("/cognito/start", (c) => {
    if (!cognito) return error(c, 404, "not_enabled", "Cognito sign-in is not enabled");
    const provider = c.req.query("provider");
    if (provider && !cognito.providers.includes(provider))
      return error(c, 400, "unknown_provider", "This sign-in provider is not enabled");
    const pending = {
      state: newToken(),
      verifier: newToken(48),
      invite: c.req.query("invite") || undefined,
      next: safeNext(c.req.query("next")),
    };
    setCookie(c, COGNITO_COOKIE, Buffer.from(JSON.stringify(pending)).toString("base64url"), {
      httpOnly: true,
      // Lax: the cookie comes back on Cognito's redirect, which is a top-level GET.
      sameSite: "Lax",
      path: "/auth/cognito",
      maxAge: 600,
      secure: secure(c),
    });
    return c.redirect(
      authorizeUrl(cognito, {
        state: pending.state,
        verifier: pending.verifier,
        provider,
        signup: c.req.query("screen") === "signup",
        reauth: c.req.query("reauth") === "1",
      }),
    );
  });

  app.get("/cognito/callback", async (c) => {
    if (!cognito) return error(c, 404, "not_enabled", "Cognito sign-in is not enabled");
    const saved = getCookie(c, COGNITO_COOKIE);
    deleteCookie(c, COGNITO_COOKIE, { path: "/auth/cognito" });
    let pending: { state?: string; verifier?: string; invite?: string; next?: string } = {};
    try {
      pending = saved ? JSON.parse(Buffer.from(saved, "base64url").toString("utf8")) : {};
    } catch {
      // Treated as no sign-in in progress.
    }
    const problem = c.req.query("error_description") ?? c.req.query("error");
    if (problem) return backToConsole(c, problem);
    const code = c.req.query("code");
    if (!code || !pending.state || !pending.verifier || c.req.query("state") !== pending.state)
      return backToConsole(c, "The sign-in took too long or was started in another browser. Try again.");
    let claims, accessToken;
    try {
      const tokens = await exchangeCode(cognito, code, pending.verifier, doFetch);
      claims = await verifyIdToken(cognito, tokens.idToken, doFetch, now());
      accessToken = tokens.accessToken;
    } catch (e) {
      if (e instanceof CognitoError) return backToConsole(c, e.message);
      throw e;
    }
    const result = await signInIdentity(
      "cognito",
      {
        subject: claims.sub,
        email: claims.email,
        strategy: claims.provider === "Google" ? "google" : claims.provider ? undefined : "email_password",
        displayName: claims.name,
        firstName: claims.given_name,
        lastName: claims.family_name,
      },
      pending.invite,
    );
    if ("status" in result) return backToConsole(c, result.message);
    if (result.joined) await joined(c, result.user, result.joined);
    if (result.invite) {
      const accepted = await accounts.acceptInvite(result.invite, result.user, now());
      if (!accepted.ok) return backToConsole(c, "This invite is not valid any more");
      await joined(c, result.user, accepted.workspace_id);
    }
    await setUpNewUser(accounts, users, result.user, now());
    await startSession(c, sessions, result.user, now(), trustProxy);
    const access = accessToken ? accessTokenClaims(accessToken) : null;
    if (accessToken && access?.sub === claims.sub) {
      setCookie(c, ACCESS_COOKIE, accessToken, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/auth/mfa",
        maxAge: Math.max(0, access.exp - Math.floor(now().getTime() / 1000)),
        secure: secure(c),
      });
    }
    return backToConsole(c, undefined, safeNext(pending.next));
  });

  // Two-factor authentication (an authenticator app) for people who sign in to Cognito with a
  // password. Cognito keeps the second factor; these routes turn it on and off with the person's
  // own access token, from the cookie that the callback set.
  const mfaAccess = async (c: Context) => {
    if (!cognito) return { response: error(c, 404, "not_enabled", "Cognito sign-in is not enabled") };
    const user = await signedIn(c);
    if (!user) return { response: notSignedIn(c) };
    const identity = await users.cognitoIdentityOf(user.id);
    if (!identity || identity.strategy === "google")
      return { response: error(c, 400, "mfa_not_used", "Two-factor authentication is set up where you sign in") };
    const token = getCookie(c, ACCESS_COOKIE);
    const claims = token ? accessTokenClaims(token) : null;
    const nowSeconds = Math.floor(now().getTime() / 1000);
    // A token of another person (another account signed in on this browser before) is not used.
    if (!token || !claims || claims.sub !== identity.subject || claims.exp <= nowSeconds)
      return { stale: true as const };
    return { token, claims, nowSeconds, user };
  };
  const reauthNeeded = (c: Context) =>
    error(c, 403, "reauth_required", "Sign in again to change two-factor authentication");
  // A change needs a recent sign-in, which asked for the password: a session left open is not enough,
  // or anyone at it could put their own authenticator app on the account.
  const tooOld = (access: { nowSeconds: number; claims: { authTime: number } }) =>
    access.nowSeconds - access.claims.authTime > REAUTH_SECONDS;
  const mfaFailed = (c: Context, e: unknown) => {
    if (!(e instanceof CognitoError)) throw e;
    if (e.unavailable) return error(c, 502, "cognito_unavailable", e.message);
    return e.message.startsWith("Sign in again") ? reauthNeeded(c) : error(c, 400, "mfa_failed", e.message);
  };

  app.get("/mfa", async (c) => {
    if (!cognito) return error(c, 404, "not_enabled", "Cognito sign-in is not enabled");
    const user = await signedIn(c);
    if (!user) return notSignedIn(c);
    const identity = await users.cognitoIdentityOf(user.id);
    if (!identity) return c.json({ available: false, reason: "not_cognito" });
    if (identity.strategy === "google") return c.json({ available: false, reason: "google" });
    const access = await mfaAccess(c);
    if ("response" in access) return access.response;
    if ("stale" in access) return c.json({ available: true, enabled: null, reauth_required: true });
    try {
      const me = await userApi<{ UserMFASettingList?: string[] }>(
        cognito,
        "GetUser",
        { AccessToken: access.token },
        doFetch,
      );
      return c.json({
        available: true,
        enabled: (me.UserMFASettingList ?? []).includes("SOFTWARE_TOKEN_MFA"),
        reauth_required: false,
      });
    } catch (e) {
      if (e instanceof CognitoError && e.message.startsWith("Sign in again"))
        return c.json({ available: true, enabled: null, reauth_required: true });
      return mfaFailed(c, e);
    }
  });

  // Step 1 of turning it on: a new secret for the authenticator app.
  app.post("/mfa/setup", async (c) => {
    const access = await mfaAccess(c);
    if ("response" in access) return access.response;
    if ("stale" in access || tooOld(access)) return reauthNeeded(c);
    try {
      const { SecretCode } = await userApi<{ SecretCode: string }>(
        cognito!,
        "AssociateSoftwareToken",
        { AccessToken: access.token },
        doFetch,
      );
      const label = encodeURIComponent(`Kairos:${access.user.email}`);
      return c.json({
        secret: SecretCode,
        otpauth_uri: `otpauth://totp/${label}?${new URLSearchParams({ secret: SecretCode, issuer: "Kairos" })}`,
      });
    } catch (e) {
      return mfaFailed(c, e);
    }
  });

  // Step 2: the first code from the app proves it is set up; then Cognito asks for a code at each sign-in.
  app.post("/mfa/verify", async (c) => {
    const access = await mfaAccess(c);
    if ("response" in access) return access.response;
    if ("stale" in access || tooOld(access)) return reauthNeeded(c);
    const input = await parse(c, mfaCodeBody);
    if ("response" in input) return input.response;
    try {
      const verified = await userApi<{ Status?: string }>(
        cognito!,
        "VerifySoftwareToken",
        { AccessToken: access.token, UserCode: input.data.code, FriendlyDeviceName: "Kairos" },
        doFetch,
      );
      if (verified.Status !== "SUCCESS")
        return error(c, 400, "mfa_failed", "The code is not correct. Try the newest code from your app.");
      await userApi(
        cognito!,
        "SetUserMFAPreference",
        { AccessToken: access.token, SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } },
        doFetch,
      );
      return c.json({ enabled: true });
    } catch (e) {
      return mfaFailed(c, e);
    }
  });

  app.post("/mfa/disable", async (c) => {
    const access = await mfaAccess(c);
    if ("response" in access) return access.response;
    if ("stale" in access || tooOld(access)) return reauthNeeded(c);
    try {
      await userApi(
        cognito!,
        "SetUserMFAPreference",
        { AccessToken: access.token, SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } },
        doFetch,
      );
      return c.json({ enabled: false });
    } catch (e) {
      return mfaFailed(c, e);
    }
  });

  app.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await sessions.end(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    if (cognito) deleteCookie(c, ACCESS_COOKIE, { path: "/auth/mfa" });
    // Cognito keeps a session of its own: the console goes there too, or the next sign-in skips the password.
    return c.json({ ok: true, ...(cognito ? { redirect: logoutUrl(cognito) } : {}) });
  });

  app.get("/me", async (c) => {
    const user = await signedIn(c);
    return user ? answer(c, user) : notSignedIn(c);
  });

  app.patch("/me", async (c) => {
    const user = await signedIn(c);
    if (!user) return notSignedIn(c);
    const input = await parse(c, profileBody);
    if ("response" in input) return input.response;
    await users.rename(user.id, input.data.name, now());
    return answer(c, { ...user, name: input.data.name.trim(), display_name: input.data.name.trim() });
  });

  app.post("/password", async (c) => {
    const user = await signedIn(c);
    if (!user) return notSignedIn(c);
    const input = await parse(c, passwordBody);
    if ("response" in input) return input.response;
    if ((await users.providerOf(user.id)) !== "native")
      return error(c, 400, "password_not_used", "This account signs in elsewhere, and has no password in Kairos");
    if (!input.data.current) return error(c, 400, "invalid_request", "current: is needed");
    const wait = await rateLimits.hit(LIMITS.password(user.id), now());
    if (wait > 0) return rateLimited(c, wait);
    if (!(await users.checkPassword(user.id, input.data.current)))
      return error(c, 403, "wrong_password", "The current password is not correct");
    await users.setPassword(user.id, await hashPassword(input.data.password), now());
    return c.json({ ok: true, sessions_ended: await sessions.endOthers(user.id, getCookie(c, SESSION_COOKIE)) });
  });

  app.delete("/me", async (c) => {
    const user = await signedIn(c);
    if (!user) return notSignedIn(c);
    const input = await parse(c, deleteAccountBody);
    if ("response" in input) return input.response;
    const isNative = (await users.providerOf(user.id)) === "native";
    if (isNative) {
      if (!input.data.password) return error(c, 400, "invalid_request", "password: is needed");
      const wait = await rateLimits.hit(LIMITS.password(user.id), now());
      if (wait > 0) return rateLimited(c, wait);
    }
    if (
      isNative
        ? !(await users.checkPassword(user.id, input.data.password))
        : normalizeEmail(input.data.confirm) !== user.email
    ) {
      return error(
        c,
        403,
        "not_confirmed",
        isNative ? "The password is not correct" : "Type your email address to confirm",
      );
    }
    const owned = await accounts.soleOwnerOf(user.id);
    const shared = owned.filter((w) => w.others > 0);
    if (shared.length > 0) {
      return error(
        c,
        409,
        "sole_owner",
        `You are the only owner of ${shared.map((w) => w.name).join(", ")}. Make another member an owner, or delete the workspace, before you delete your account.`,
      );
    }
    for (const workspace of owned) await workspaces.delete(workspace.id);
    await users.delete(user.id);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true, workspaces_deleted: owned.length });
  });

  app.get("/invites/:token", async (c) => {
    const invite = await accounts.inviteByToken(c.req.param("token"), now());
    if (!invite) return error(c, 404, "invite_invalid", "This invite is not valid any more");
    return c.json({
      email: invite.email,
      role: invite.role,
      workspace_name: invite.workspace_name,
      has_account: (await users.findByEmail(invite.email)) !== null,
    });
  });

  app.post("/invites/:token/accept", async (c) => {
    const user = await signedIn(c);
    if (!user) return notSignedIn(c, "Sign in to accept the invite");
    const result = await accounts.acceptInvite(c.req.param("token"), user, now());
    if (!result.ok)
      return error(
        c,
        403,
        "invite_invalid",
        result.reason === "wrong_email"
          ? `This invite is for a different email address. You are signed in as ${user.email}.`
          : "This invite is not valid any more",
      );
    await joined(c, user, result.workspace_id);
    return c.json({ workspace_id: result.workspace_id, ...(await profile(accounts, users, environments, user)) });
  });

  return app;
}
