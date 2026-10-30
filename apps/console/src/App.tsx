import { Fragment, useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router";
import { auth, SIGNED_OUT } from "./api/index";
import type { AuthConfig, Session } from "./types/interfaces";
import { AuthLayout } from "./layouts/AuthLayout";
import { AcceptInvite, AuthPage, takeSupabaseToken } from "./pages/Auth";
import { NewWorkspacePage } from "./pages/workspaces/NewWorkspacePage";
import { queryClient } from "./lib/queryClient";
import { rememberAppRoute } from "./lib/route";
import { ScopeProvider } from "./lib/scope";
import { WorkspaceContext } from "./lib/workspace";
import { useRoute } from "./hooks/useRoute";

const LAST_WORKSPACE = "kairos.workspace";
const remembered = () => {
  try {
    return localStorage.getItem(LAST_WORKSPACE);
  } catch {
    return null;
  }
};
const remember = (id: string) => {
  try {
    localStorage.setItem(LAST_WORKSPACE, id);
  } catch {}
};

export function App() {
  const route = useRoute();
  const navigate = useNavigate();
  const [config, setConfig] = useState<AuthConfig | null>(null);
  // undefined while the session loads, null when nobody is signed in.
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  // What one person loaded is not shown to the next one.
  useEffect(() => {
    if (session === null) queryClient.clear();
  }, [session]);
  const [selectedEnvironments, setSelectedEnvironments] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(remembered);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fromSupabase = takeSupabaseToken();
    const who = fromSupabase ? auth.supabase(fromSupabase.token, fromSupabase.invite) : auth.me();
    Promise.all([auth.config(), who]).then(
      ([c, s]) => (setConfig(c), setSession(s)),
      (e: Error) => setError(e.message),
    );
    const onSignedOut = () => setSession(null);
    window.addEventListener(SIGNED_OUT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT, onSignedOut);
  }, []);

  const choose = (id: string) => (remember(id), setSelected(id));
  const refresh = () => auth.me().then(setSession, () => {});
  const signOut = () =>
    auth.logout().then(
      () => setSession(null),
      () => setSession(null),
    );

  if (error)
    return (
      <AuthLayout title="Kairos is not reachable">
        <div className="banner">{error}</div>
        <button className="btn block-w" onClick={() => window.location.reload()}>
          Try again
        </button>
      </AuthLayout>
    );
  if (session === undefined || !config) return <div className="auth muted">Loading…</div>;

  const inviteToken = route[0] === "invite" ? route[1] : undefined;
  if (!session) return <AuthPage key={inviteToken} config={config} inviteToken={inviteToken} onSession={setSession} />;
  if (inviteToken)
    return (
      <AcceptInvite
        token={inviteToken}
        session={session}
        onSession={(next, id) => (id && choose(id), setSession(next))}
        onSignOut={signOut}
      />
    );

  const workspace = session.workspaces.find((w) => w.id === selected) ?? session.workspaces[0];
  if (!workspace)
    return (
      <NewWorkspacePage
        lede="You are not in a workspace. Create one, or ask for an invite link."
        cancel={{ label: "Sign out", onClick: signOut }}
        onDone={async (id) => {
          await refresh();
          choose(id);
          navigate("/get-started");
        }}
      />
    );
  let savedEnvironment: string | null = null;
  try {
    savedEnvironment = localStorage.getItem(`kairos.environment.${workspace.id}`);
  } catch {}
  const wanted = selectedEnvironments[workspace.id] ?? savedEnvironment;
  const environment =
    workspace.environments.find((e) => e.id === wanted) ?? workspace.environments.find((e) => e.kind === "production");
  if (!environment)
    return (
      <AuthLayout title="Environment unavailable">
        <p>We couldn't load this workspace's environments.</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Try again
        </button>
      </AuthLayout>
    );
  const chooseEnvironment = (id: string) => {
    try {
      localStorage.setItem(`kairos.environment.${workspace.id}`, id);
    } catch {}
    setSelectedEnvironments((current) => ({ ...current, [workspace.id]: id }));
    rememberAppRoute(["overview"]);
    if (route[0] !== "settings") navigate("/overview");
  };
  const state = {
    session,
    workspace,
    environment,
    onChooseEnvironment: chooseEnvironment,
    onChoose: choose,
    onRefresh: refresh,
    onSignOut: signOut,
    onSignedOut: () => setSession(null),
  };
  return (
    <WorkspaceContext.Provider value={state}>
      <ScopeProvider workspaceId={workspace.id} environmentId={environment.id}>
        {/* Nothing loaded for one workspace or environment stays on the page of the next. */}
        <Fragment key={`${workspace.id}:${environment.id}`}>
          <Outlet />
        </Fragment>
      </ScopeProvider>
    </WorkspaceContext.Provider>
  );
}
