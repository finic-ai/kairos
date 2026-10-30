import { createHash, createPublicKey, verify, type JsonWebKey } from "node:crypto";

/**
 * Amazon Cognito, when it is configured: the console sends the person to the Cognito managed
 * login page, which offers email and password (with two-factor authentication), Google and
 * any other identity provider of the user pool. Cognito sends them back with a code, and the
 * server trades it for an ID token, checks the token, and starts its own session.
 */
export interface CognitoConfig {
  /** The managed login domain, such as https://kairos.auth.us-east-1.amazoncognito.com. */
  domain: string;
  /** The user pool, such as https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbC123. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Where people open Kairos, such as https://kairos.example.com. The callback is under it. */
  publicUrl: string;
  /** Identity providers of the user pool that get a button of their own, such as Google. */
  providers: string[];
}

export interface CognitoClaims {
  sub: string;
  email: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  /** The federated provider, such as "Google", or undefined for a Cognito email and password. */
  provider?: string;
}

const trim = (url: string) => url.replace(/\/+$/, "");
export const callbackUrl = (config: CognitoConfig) => `${trim(config.publicUrl)}/auth/cognito/callback`;

/** The PKCE challenge of a verifier. */
export const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export function authorizeUrl(
  config: CognitoConfig,
  options: { state: string; verifier: string; provider?: string; signup?: boolean; reauth?: boolean },
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: callbackUrl(config),
    // aws.cognito.signin.user.admin: the access token may change the person's own second factor.
    scope: "openid email profile aws.cognito.signin.user.admin",
    state: options.state,
    code_challenge: challengeOf(options.verifier),
    code_challenge_method: "S256",
    ...(options.provider ? { identity_provider: options.provider } : {}),
    // Asks for the password (and the second factor) again, even with a Cognito session.
    ...(options.reauth ? { prompt: "login" } : {}),
  });
  // A provider goes straight to that provider; otherwise the managed login page, on its sign-up form when asked.
  const page = !options.provider && options.signup ? "signup" : "oauth2/authorize";
  return `${trim(config.domain)}/${page}?${query}`;
}

export const logoutUrl = (config: CognitoConfig) =>
  `${trim(config.domain)}/logout?${new URLSearchParams({ client_id: config.clientId, logout_uri: `${trim(config.publicUrl)}/` })}`;

export class CognitoError extends Error {
  constructor(
    message: string,
    readonly unavailable = false,
  ) {
    super(message);
  }
}

/** Trades the code from the callback for an ID token and an access token. */
export async function exchangeCode(
  config: CognitoConfig,
  code: string,
  verifier: string,
  doFetch: typeof fetch,
): Promise<{ idToken: string; accessToken?: string }> {
  let response: Response;
  try {
    response = await doFetch(`${trim(config.domain)}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code,
        redirect_uri: callbackUrl(config),
        code_verifier: verifier,
      }).toString(),
    });
  } catch {
    throw new CognitoError("Cognito could not be reached", true);
  }
  const data = (await response.json().catch(() => null)) as { id_token?: string; access_token?: string } | null;
  if (!response.ok || !data?.id_token) throw new CognitoError("Cognito did not accept this sign-in");
  return { idToken: data.id_token, accessToken: data.access_token };
}

/**
 * What an access token says about itself. Not checked here: Cognito checks the token on each
 * call that uses it, so a token that was changed is refused there.
 */
export function accessTokenClaims(token: string): { sub: string; exp: number; authTime: number } | null {
  try {
    const claims = part(token.split(".")[1] ?? "");
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    return { sub: claims.sub, exp: claims.exp, authTime: typeof claims.auth_time === "number" ? claims.auth_time : 0 };
  } catch {
    return null;
  }
}

/**
 * Calls a Cognito user pool API on the person's behalf, with their access token: GetUser,
 * AssociateSoftwareToken, VerifySoftwareToken, SetUserMFAPreference. No AWS credentials.
 */
export async function userApi<T>(
  config: CognitoConfig,
  action: string,
  body: Record<string, unknown>,
  doFetch: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await doFetch(`${new URL(config.issuer).origin}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": `AWSCognitoIdentityProviderService.${action}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new CognitoError("Cognito could not be reached", true);
  }
  const data = (await response.json().catch(() => ({}))) as T & { __type?: string; message?: string };
  if (!response.ok) {
    const type = (data.__type ?? "").split("#").pop();
    throw new CognitoError(
      type === "NotAuthorizedException"
        ? "Sign in again to change two-factor authentication"
        : type === "CodeMismatchException" || type === "EnableSoftwareTokenMFAException"
          ? "The code is not correct. Try the newest code from your app."
          : (data.message ?? "Cognito did not accept this change"),
    );
  }
  return data;
}

type Jwk = JsonWebKey & { kid?: string };
const jwks = new Map<string, Promise<Jwk[]>>();

async function keysOf(issuer: string, doFetch: typeof fetch): Promise<Jwk[]> {
  let keys = jwks.get(issuer);
  if (!keys) {
    keys = doFetch(`${trim(issuer)}/.well-known/jwks.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`JWKS ${r.status}`))))
      .then((body) => (body as { keys: Jwk[] }).keys);
    jwks.set(issuer, keys);
    // A failed fetch is not kept, so the next sign-in tries again.
    keys.catch(() => jwks.delete(issuer));
  }
  return keys.catch(() => {
    throw new CognitoError("Cognito could not be reached", true);
  });
}

const part = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

/** Checks the signature, the issuer, the audience, the use and the time of a Cognito ID token. */
export async function verifyIdToken(
  config: CognitoConfig,
  token: string,
  doFetch: typeof fetch,
  now: Date,
): Promise<CognitoClaims> {
  const segments = token.split(".");
  if (segments.length !== 3) throw new CognitoError("Cognito returned a token that is not valid");
  const [head, body, signature] = segments as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = part(head);
    claims = part(body);
  } catch {
    throw new CognitoError("Cognito returned a token that is not valid");
  }
  if (header.alg !== "RS256") throw new CognitoError("Cognito returned a token that is not valid");
  let key = (await keysOf(config.issuer, doFetch)).find((k) => k.kid === header.kid);
  if (!key) {
    // The pool may have rotated its keys since they were read.
    jwks.delete(config.issuer);
    key = (await keysOf(config.issuer, doFetch)).find((k) => k.kid === header.kid);
  }
  if (!key) throw new CognitoError("Cognito returned a token that is not valid");
  const signed = verify(
    "RSA-SHA256",
    Buffer.from(`${head}.${body}`),
    createPublicKey({ key, format: "jwk" }),
    Buffer.from(signature, "base64url"),
  );
  if (
    !signed ||
    claims.iss !== trim(config.issuer) ||
    claims.aud !== config.clientId ||
    claims.token_use !== "id" ||
    typeof claims.exp !== "number" ||
    claims.exp * 1000 <= now.getTime()
  )
    throw new CognitoError("Cognito returned a token that is not valid");
  if (typeof claims.sub !== "string" || typeof claims.email !== "string")
    throw new CognitoError("Cognito did not return an email address");
  // Cognito checks a new address with a code; a federated provider vouches for its own.
  if (claims.email_verified === false || claims.email_verified === "false")
    throw new CognitoError("Confirm your email address with Cognito first");
  const identities = Array.isArray(claims.identities) ? (claims.identities as { providerName?: string }[]) : [];
  const text = (name: string) => (typeof claims[name] === "string" ? (claims[name] as string) : undefined);
  return {
    sub: claims.sub,
    email: claims.email,
    name: text("name"),
    given_name: text("given_name"),
    family_name: text("family_name"),
    provider: identities[0]?.providerName,
  };
}

/** For the tests: forget the keys that were read. */
export const forgetKeys = () => jwks.clear();
