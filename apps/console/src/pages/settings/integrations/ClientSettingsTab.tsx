import { useEffect, useState } from "react";
import { workspaces } from "../../../api/index";
import { MODES, RouteModal } from "../../../components/settings/RouteModal";
import { Banner, type Message } from "../../../components/ui/Banner";
import { Group, Row } from "../../../components/ui/Group";
import { Pairs, type Pair } from "../../../components/ui/Pairs";
import { Empty, Loading } from "../../../components/ui/states";
import { Switch } from "../../../components/ui/Switch";
import { useApi } from "../../../hooks/useApi";
import type {
  ClientRoute,
  ClientSettings,
  DataKind,
  RoutingMode,
  Environment,
  Workspace,
} from "../../../types/interfaces";

type Draft = Omit<ClientSettings, "version">;

const DATA_KINDS: { id: DataKind; title: string }[] = [
  { id: "email", title: "Emails" },
  { id: "phone", title: "Phone numbers" },
  { id: "address", title: "Addresses" },
  { id: "username", title: "Usernames" },
];

const ROUTING_MODES: { id: RoutingMode; title: string; note: string }[] = [
  {
    id: "off",
    title: "Off",
    note: "The edge and the middleware send nothing for routes, and every request goes to your app unchanged.",
  },
  { id: "monitor", title: "Monitor", note: "The routes track and decide, but never block, even with Enforce on." },
  { id: "active", title: "Active", note: "Routes with Enforce on can block, redirect or step up." },
];

const draftOf = ({ version: _, ...rest }: ClientSettings): Draft => rest;

/** Rows the person added and left empty are not settings. */
const cleaned = (d: Draft): Draft => ({
  ...d,
  defaults: {
    off: d.defaults.off,
    ...(d.defaults.country?.trim() ? { country: d.defaults.country.trim() } : {}),
    ...(d.defaults.sessionCookie?.trim() ? { sessionCookie: d.defaults.sessionCookie.trim() } : {}),
  },
  pages: d.pages.filter((p) => p.path.trim() || p.type.trim()),
  screens: d.screens.filter((s) => s.name.trim() || s.type.trim()),
});

function Listed({ items, empty }: { items: Pair[]; empty: string }) {
  if (items.length === 0) return <span className="muted">{empty}</span>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {items.map(([code, text]) => (
        <div key={code}>
          <span className="mono">{code}</span> <span className="muted">→ {text}</span>
        </div>
      ))}
    </div>
  );
}

export function ClientSettingsTab({
  workspace,
  environment,
  onChooseEnvironment,
}: {
  workspace: Workspace;
  environment: Environment;
  onChooseEnvironment: (id: string) => void;
}) {
  const manage = workspace.role !== "member";
  const {
    data,
    error: loadError,
    refetch,
  } = useApi(["client-settings", workspace.id, environment.id], () => workspaces.clientSettings(workspace.id));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [editing, setEditing] = useState<{ index: number | null } | null>(null);

  useEffect(() => {
    if (data) setDraft(draftOf(data));
  }, [data]);

  const banner = <Banner message={message ?? (loadError ? { ok: false, text: loadError.message } : null)} />;
  if (!data || !draft)
    return (
      <>
        {banner}
        <div className="card">
          <Loading />
        </div>
      </>
    );

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const next = cleaned(draft);
  const changed = JSON.stringify(next) !== JSON.stringify(cleaned(draftOf(data)));

  const save = () =>
    workspaces.setClientSettings(workspace.id, next).then(
      (saved) => (
        setMessage({ ok: true, text: `Client settings for ${environment.name} saved as version ${saved.version}.` }),
        refetch()
      ),
      (e: Error) => setMessage({ ok: false, text: e.message }),
    );
  const choose = (id: string) => {
    if (id === environment.id) return;
    if (changed && !window.confirm(`Discard the changes to ${environment.name} that are not saved?`)) return;
    setMessage(null);
    onChooseEnvironment(id);
  };
  const saveRoute = (route: ClientRoute) => {
    const index = editing?.index ?? null;
    set({ routes: index === null ? [...draft.routes, route] : draft.routes.map((r, i) => (i === index ? route : r)) });
    setEditing(null);
  };
  const toggleOff = (kind: DataKind, off: boolean) =>
    set({
      defaults: {
        ...draft.defaults,
        off: off ? [...draft.defaults.off, kind] : draft.defaults.off.filter((k) => k !== kind),
      },
    });

  return (
    <>
      {banner}
      <p className="muted" style={{ margin: "0 0 24px" }}>
        What the website script, the mobile SDKs, your edge function and the SDK middleware collect. Each environment
        has its own settings, read by its own keys, so you can try a change in a sandbox before Production. They read
        them when they start, so a change needs no deployment.
        {!manage && " Only owners and admins can change them."}
      </p>

      <Group
        title="General"
        note="For every client."
        action={
          <select
            className="input"
            style={{ width: "auto" }}
            value={environment.id}
            aria-label="Environment"
            onChange={(e) => choose(e.target.value)}
          >
            {workspace.environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.kind === "production" ? env.name : `${env.name} (sandbox)`}
              </option>
            ))}
          </select>
        }
      >
        <div className="card rows">
          <Row
            title="Ask for consent"
            note="The website script and the mobile SDKs send nothing, and keep no device id, until your app gives consent."
          >
            <Switch
              checked={draft.consent === "required"}
              disabled={!manage}
              title="Ask for consent"
              onChange={(on) => set({ consent: on ? "required" : "not_required" })}
            />
          </Row>
          <Row title="Country" note="For a phone number with no country code. Two letters, such as GB.">
            <input
              className="input"
              style={{ width: 80 }}
              maxLength={2}
              placeholder="GB"
              value={draft.defaults.country ?? ""}
              disabled={!manage}
              onChange={(e) => set({ defaults: { ...draft.defaults, country: e.target.value.toUpperCase() } })}
            />
          </Row>
          <Row title="Personal data" note="Turn a kind off to never send it, from any page, screen or route.">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, auto)", gap: "10px 18px" }}>
              {DATA_KINDS.map((kind) => (
                <Switch
                  key={kind.id}
                  checked={!draft.defaults.off.includes(kind.id)}
                  disabled={!manage}
                  label={kind.title}
                  onChange={(on) => toggleOff(kind.id, !on)}
                />
              ))}
            </div>
          </Row>
        </div>
      </Group>

      <Group
        title="Website"
        note="Pages that the website script tracks. Each page sends its own event type, such as checkout_viewed."
      >
        <div className="card" style={{ padding: 18 }}>
          {manage ? (
            <Pairs
              items={draft.pages.map((p) => [p.path, p.type])}
              onChange={(items) => set({ pages: items.map(([path, type]) => ({ path, type })) })}
              codeHint="/checkout"
              textHint="checkout_viewed"
            />
          ) : (
            <Listed items={draft.pages.map((p) => [p.path, p.type])} empty="No pages" />
          )}
        </div>
      </Group>

      <Group
        title="Mobile apps"
        note="Screens that the mobile SDKs track, by the screen name in your app's navigation."
      >
        <div className="card" style={{ padding: 18 }}>
          {manage ? (
            <Pairs
              items={draft.screens.map((s) => [s.name, s.type])}
              onChange={(items) => set({ screens: items.map(([name, type]) => ({ name, type })) })}
              codeHint="Transfer"
              textHint="transfer_screen_viewed"
            />
          ) : (
            <Listed items={draft.screens.map((s) => [s.name, s.type])} empty="No screens" />
          )}
        </div>
      </Group>

      <Group
        title="Edge & Middleware"
        note={
          <>
            Requests that your edge function sends as events, or asks Kairos to decide on. The SDK middleware runs them
            too when you pass <span className="mono">clientSettings: true</span>, except Decide on response, which only
            the edge can do.
          </>
        }
        action={
          manage && (
            <button className="btn primary" onClick={() => setEditing({ index: null })}>
              Add route
            </button>
          )
        }
      >
        <div className="card rows" style={{ marginBottom: 12 }}>
          <Row title="Route mode" note={ROUTING_MODES.find((m) => m.id === draft.routing.mode)!.note}>
            <select
              className="input"
              value={draft.routing.mode}
              disabled={!manage}
              aria-label="Route mode"
              onChange={(e) => set({ routing: { ...draft.routing, mode: e.target.value as RoutingMode } })}
            >
              {ROUTING_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          </Row>
          <Row
            title="Other requests"
            note={
              draft.routing.other === "discover"
                ? "For a sample of requests that match no route, the shape of the body is sent: key names and value types, never values."
                : "Requests that match no route go to your app, and nothing is sent to Kairos."
            }
          >
            <select
              className="input"
              value={draft.routing.other}
              disabled={!manage}
              aria-label="Other requests"
              onChange={(e) => set({ routing: { ...draft.routing, other: e.target.value as "ignore" | "discover" } })}
            >
              <option value="ignore">Ignore</option>
              <option value="discover">Discover</option>
            </select>
          </Row>
          <Row
            title="Session cookie"
            note="The name of your login session cookie. Kairos gets a hash of it, never the cookie itself."
          >
            <input
              className="input mono"
              placeholder="sid"
              value={draft.defaults.sessionCookie ?? ""}
              disabled={!manage}
              onChange={(e) => set({ defaults: { ...draft.defaults, sessionCookie: e.target.value } })}
            />
          </Row>
        </div>
        <div className="card table-wrap">
          {draft.routes.length === 0 ? (
            <Empty title="No routes">
              Add the routes whose requests Kairos should see, such as a login or a transfer.
            </Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Route</th>
                  <th>What happens</th>
                  <th>Event</th>
                  <th className="hide-md">Fields</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {draft.routes.map((route, i) => (
                  <tr key={i}>
                    <td className="mono">{route.route}</td>
                    <td>
                      {MODES.find((m) => m.id === route.mode)!.title}
                      {route.mode === "decide_response" && <span className="chip edge-only">Edge only</span>}
                      {route.mode !== "track" && (
                        <div className="muted">
                          {!route.enforce ? "Monitor" : draft.routing.mode === "active" ? "Enforce" : "Enforce, paused"}
                        </div>
                      )}
                    </td>
                    <td className="mono">
                      {route.type}
                      {route.failed && <div className="muted">{route.failed}</div>}
                    </td>
                    <td className="hide-md mono">
                      {Object.keys(route.fields).join(", ") || <span className="muted">none</span>}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {manage && (
                        <>
                          <button className="btn ghost" onClick={() => setEditing({ index: i })}>
                            Edit
                          </button>
                          <button
                            className="icon-btn"
                            aria-label={`Remove ${route.route}`}
                            onClick={() => set({ routes: draft.routes.filter((_, j) => j !== i) })}
                          >
                            ×
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Group>

      {manage && (
        <div className="card save-bar">
          <span className="muted">
            {changed
              ? "You have changes that are not saved."
              : data.version === 0
                ? "Not saved yet."
                : `Version ${data.version}.`}
          </span>
          <div className="row">
            <button className="btn" disabled={!changed} onClick={() => (setDraft(draftOf(data)), setMessage(null))}>
              Discard
            </button>
            <button className="btn primary" disabled={!changed} onClick={save}>
              Save
            </button>
          </div>
        </div>
      )}

      {editing && (
        <RouteModal
          route={editing.index === null ? undefined : draft.routes[editing.index]}
          onClose={() => setEditing(null)}
          onSave={saveRoute}
        />
      )}
    </>
  );
}
