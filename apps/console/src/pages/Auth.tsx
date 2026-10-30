import { useEffect, useState, FormEvent } from "react";
import { auth } from "../api/index";
import type { AuthConfig, InviteInfo, Session } from "../types/interfaces";
import { AuthLayout } from "../layouts/AuthLayout";
import { go } from "../lib/route";

/** An invite token is kept while the person goes to Supabase and comes back. Cognito keeps its own on the server. */
const PENDING_INVITE = "kairos.invite";

const supabaseHeaders = (config: NonNullable<AuthConfig["supabase"]>) => ({
  apikey: config.anon_key,
  "Content-Type": "application/json",
});
const supabaseUrl = (config: NonNullable<AuthConfig["supabase"]>, path: string) =>
  `${config.url.replace(/\/+$/, "")}/auth/v1/${path}`;

let fromSupabase: { token: string; invite?: string } | null = null;

export function captureSupabaseToken() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash.includes("access_token=")) return;
  const token = new URLSearchParams(hash).get("access_token");
  const invite = sessionStorage.getItem(PENDING_INVITE) ?? undefined;
  sessionStorage.removeItem(PENDING_INVITE);
  window.history.replaceState(null, "", window.location.pathname);
  if (token) fromSupabase = { token, invite };
}

export function takeSupabaseToken(): { token: string; invite?: string } | null {
  const taken = fromSupabase;
  fromSupabase = null;
  return taken;
}

/** A Cognito sign-in that failed comes back to `/?auth_error=…`; the sign-in page shows it. */
let authError: string | null = null;

export function captureAuthError() {
  const params = new URLSearchParams(window.location.search);
  const problem = params.get("auth_error");
  if (!problem) return;
  authError = problem;
  params.delete("auth_error");
  const rest = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
}

const takeAuthError = () => {
  const taken = authError;
  authError = null;
  return taken;
};

const cognitoStart = (options: { provider?: string; signup?: boolean; invite?: string }) =>
  `/auth/cognito/start?${new URLSearchParams({
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.signup ? { screen: "signup" } : {}),
    ...(options.invite ? { invite: options.invite } : {}),
  })}`;

export function AuthPage({
  config,
  inviteToken,
  onSession,
}: {
  config: AuthConfig;
  inviteToken?: string;
  onSession: (session: Session) => void;
}) {
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(takeAuthError);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!inviteToken) return;
    auth.invite(inviteToken).then(
      (info) => (setInvite(info), setEmail(info.email), setMode(info.has_account ? "login" : "signup")),
      (e: Error) => setError(e.message),
    );
  }, [inviteToken]);

  const canSignUp = config.signup || invite !== null;
  const finish = (session: Session) => (inviteToken && go("overview"), onSession(session));

  const run = async (work: () => Promise<Session | null>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const session = await work();
      if (session) finish(session);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      if (mode === "signup") return auth.signup({ email, password, name, invite: inviteToken });
      await auth.login(email, password);
      // An account that exists joins the workspace after it signs in.
      return inviteToken ? auth.acceptInvite(inviteToken) : auth.me();
    });
  };

  const withSupabase = () =>
    run(async () => {
      const supabase = config.supabase!;
      const path =
        mode === "signup"
          ? `signup?redirect_to=${encodeURIComponent(window.location.origin)}`
          : "token?grant_type=password";
      if (inviteToken) sessionStorage.setItem(PENDING_INVITE, inviteToken);
      const response = await fetch(supabaseUrl(supabase, path), {
        method: "POST",
        headers: supabaseHeaders(supabase),
        body: JSON.stringify({ email, password, ...(mode === "signup" ? { data: { full_name: name } } : {}) }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          data?.msg ?? data?.error_description ?? data?.message ?? "Supabase did not accept this sign-in",
        );
      if (!data?.access_token) {
        setNotice("Supabase sent a confirmation email. Open the link in it to continue.");
        return null;
      }
      sessionStorage.removeItem(PENDING_INVITE);
      return auth.supabase(data.access_token, inviteToken);
    });

  const withProvider = (provider: string) => {
    if (inviteToken) sessionStorage.setItem(PENDING_INVITE, inviteToken);
    window.location.href = supabaseUrl(
      config.supabase!,
      `authorize?provider=${encodeURIComponent(provider)}&redirect_to=${encodeURIComponent(window.location.origin)}`,
    );
  };

  const title = invite
    ? `Join ${invite.workspace_name}`
    : mode === "signup"
      ? "Create your account"
      : "Sign in to Kairos";
  const lede = invite
    ? `You are invited as ${invite.role === "admin" ? "an admin" : invite.role === "owner" ? "an owner" : "a member"}. ${invite.has_account ? "Sign in to accept." : "Create an account to accept."}`
    : mode === "signup"
      ? "You get a workspace of your own. You can invite other people later."
      : undefined;

  if (config.cognito && !config.password)
    return (
      <AuthLayout title={title} lede={lede}>
        {error && <div className="banner">{error}</div>}
        <div className="stack" style={{ gap: 14 }}>
          <a className="btn primary block-w" href={cognitoStart({ signup: mode === "signup", invite: inviteToken })}>
            {mode === "signup" ? "Create account with email" : "Sign in with email"}
          </a>
          {config.cognito.providers.length > 0 && <div className="or">or</div>}
          {config.cognito.providers.map((provider) => (
            <a key={provider} className="btn block-w" href={cognitoStart({ provider, invite: inviteToken })}>
              Continue with {provider}
            </a>
          ))}
        </div>
        <p className="auth-foot">
          {mode === "login" ? (
            canSignUp ? (
              <>
                No account? <a onClick={() => (setMode("signup"), setError(null))}>Create one</a>
              </>
            ) : (
              "New accounts are by invitation only. Ask an owner of your workspace for an invite link."
            )
          ) : (
            <>
              Have an account? <a onClick={() => (setMode("login"), setError(null))}>Sign in</a>
            </>
          )}
        </p>
      </AuthLayout>
    );

  return (
    <AuthLayout title={title} lede={lede}>
      {error && <div className="banner">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
      <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
        {mode === "signup" && (
          <label className="field">
            <span>Name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
              autoFocus
            />
          </label>
        )}
        <label className="field">
          <span>Email address</span>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            readOnly={invite !== null}
            required
          />
          {invite && <small>The invite is for this address only.</small>}
        </label>
        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            minLength={mode === "signup" ? 8 : undefined}
            required
          />
          {mode === "signup" && <small>At least 8 characters.</small>}
        </label>
        <button className="btn primary block-w" disabled={busy}>
          {mode === "signup" ? "Create account" : "Sign in"}
        </button>
        {config.supabase && (
          <>
            <div className="or">or</div>
            <button type="button" className="btn block-w" disabled={busy || !email || !password} onClick={withSupabase}>
              {mode === "signup" ? "Create account with Supabase" : "Sign in with Supabase"}
            </button>
            {config.supabase.providers.map((provider) => (
              <button
                type="button"
                key={provider}
                className="btn block-w"
                disabled={busy}
                onClick={() => withProvider(provider)}
              >
                Continue with {provider[0]!.toUpperCase() + provider.slice(1)}
              </button>
            ))}
          </>
        )}
      </form>
      <p className="auth-foot">
        {mode === "login" ? (
          canSignUp ? (
            <>
              No account? <a onClick={() => (setMode("signup"), setError(null))}>Create one</a>
            </>
          ) : (
            "New accounts are by invitation only. Ask an owner of your workspace for an invite link."
          )
        ) : (
          <>
            Have an account? <a onClick={() => (setMode("login"), setError(null))}>Sign in</a>
          </>
        )}
      </p>
    </AuthLayout>
  );
}

export function AcceptInvite({
  token,
  session,
  onSession,
  onSignOut,
}: {
  token: string;
  session: Session;
  onSession: (session: Session, workspace?: string) => void;
  onSignOut: () => void;
}) {
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    auth.invite(token).then(setInvite, (e: Error) => setError(e.message));
  }, [token]);

  const accept = () =>
    auth.acceptInvite(token).then(
      ({ workspace_id, ...next }) => (go("overview"), onSession(next, workspace_id)),
      (e: Error) => setError(e.message),
    );
  const wrongPerson = invite !== null && invite.email !== session.user.email;

  return (
    <AuthLayout
      title={invite ? `Join ${invite.workspace_name}` : "Invite"}
      lede={invite ? `This invite is for ${invite.email}. You are signed in as ${session.user.email}.` : undefined}
    >
      {error && <div className="banner">{error}</div>}
      <div className="stack" style={{ gap: 10 }}>
        {invite && !wrongPerson && (
          <button className="btn primary block-w" onClick={accept}>
            Accept the invite
          </button>
        )}
        {wrongPerson && (
          <button className="btn primary block-w" onClick={onSignOut}>
            Sign out and use {invite.email}
          </button>
        )}
        <button className="btn block-w" onClick={() => go("overview")}>
          Go to the console
        </button>
      </div>
    </AuthLayout>
  );
}
