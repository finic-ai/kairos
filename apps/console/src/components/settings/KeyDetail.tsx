import { FormEvent, useEffect, useState } from "react";
import { workspaces } from "../../api/index";
import { dayOf, stamp } from "../../lib/format";
import { go, href } from "../../lib/route";
import type { ApiKey, Environment, Workspace } from "../../types/interfaces";
import { Banner, type Message } from "../ui/Banner";
import { Group, Row } from "../ui/Group";

export function KindIcon({ kind }: { kind: ApiKey["kind"] }) {
  return (
    <svg className="key-kind-icon" viewBox="0 0 20 20" aria-hidden="true">
      {kind === "public" ? (
        <>
          <circle cx="10" cy="10" r="7" />
          <path d="M3 10h14M10 3c1.9 2 2.8 4.4 2.8 7s-.9 5-2.8 7c-1.9-2-2.8-4.4-2.8-7s.9-5 2.8-7z" />
        </>
      ) : (
        <>
          <rect x="4.5" y="9" width="11" height="8" rx="2" />
          <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
        </>
      )}
    </svg>
  );
}

const lines = (list: string[]) => list.join("\n");
const splitList = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** One API key: what it is, its name and restrictions to change, and revoking it. */
export function KeyDetail({
  workspace,
  environment,
  apiKey,
  onChanged,
}: {
  workspace: Workspace;
  environment: Environment;
  apiKey: ApiKey;
  onChanged: () => unknown;
}) {
  const [name, setName] = useState(apiKey.name);
  const [ips, setIps] = useState(lines(apiKey.allowed_ips));
  const [sites, setSites] = useState(lines(apiKey.allowed_origins));
  const [message, setMessage] = useState<Message | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setName(apiKey.name);
    setIps(lines(apiKey.allowed_ips));
    setSites(lines(apiKey.allowed_origins));
  }, [apiKey]);

  const revoked = !!apiKey.revoked;
  const isPublic = apiKey.kind === "public";
  const changes = {
    ...(name.trim() !== apiKey.name ? { name: name.trim() } : {}),
    ...(lines(splitList(ips)) !== lines(apiKey.allowed_ips) ? { allowed_ips: splitList(ips) } : {}),
    ...(isPublic && lines(splitList(sites)) !== lines(apiKey.allowed_origins)
      ? { allowed_origins: splitList(sites) }
      : {}),
  };
  const changed = Object.keys(changes).length > 0;

  const save = (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    workspaces
      .updateKey(workspace.id, apiKey.id, changes)
      .then(
        () => (setMessage({ ok: true, text: "Changes saved. They apply to the next request." }), onChanged()),
        (e: Error) => setMessage({ ok: false, text: e.message }),
      )
      .finally(() => setSaving(false));
  };
  const revoke = () =>
    window.confirm(`Revoke "${apiKey.name}"? Requests using this key will fail immediately.`) &&
    workspaces.revokeKey(workspace.id, apiKey.id).then(
      () => (onChanged(), go("settings", "keys")),
      (e: Error) => setMessage({ ok: false, text: e.message }),
    );

  return (
    <>
      <a className="crumb" href={href("settings", "keys")}>
        ← API Keys
      </a>
      <h1>
        {apiKey.name}{" "}
        <span className={`chip ${isPublic ? "accent" : ""}`} style={{ verticalAlign: "middle" }}>
          {apiKey.kind}
        </span>
        {revoked && (
          <span className="chip warn" style={{ verticalAlign: "middle", marginLeft: 6 }}>
            revoked
          </span>
        )}
      </h1>
      {message && <Banner message={message} />}

      <Group title="Details">
        <div className="card rows">
          <Row title="Key" note="Only the start and end are kept. The full key was shown once, when it was made.">
            <span className="mono">{apiKey.hint}</span>
          </Row>
          <Row title="Type" note={isPublic ? "Client-side. Can only send events." : "Server-side. Full API access."}>
            <span className="key-kind">
              <KindIcon kind={apiKey.kind} />
              {isPublic ? "Public" : "Secret"}
            </span>
          </Row>
          <Row title="Environment">
            <span>{environment.name}</span>
          </Row>
          <Row title="Created">
            <span>{dayOf(apiKey.created)}</span>
          </Row>
          <Row title="Last used">
            <span className={apiKey.last_used ? "mono" : "muted"}>
              {apiKey.last_used ? `${stamp(apiKey.last_used)} UTC` : "Never"}
            </span>
          </Row>
          {revoked && (
            <Row title="Revoked">
              <span>{dayOf(apiKey.revoked!)}</span>
            </Row>
          )}
        </div>
      </Group>

      <Group
        title="Modify API Key"
        note={revoked ? "A revoked key cannot be changed." : "Changes apply to the next request that uses the key."}
      >
        <form className="card rows" onSubmit={save}>
          <Row title="Name">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              disabled={revoked}
            />
          </Row>
          <Row title="Allowed IP addresses" note="One IP or IPv4 range per line. Empty allows any address.">
            <textarea
              className="input mono"
              rows={3}
              value={ips}
              onChange={(e) => setIps(e.target.value)}
              placeholder={"203.0.113.7\n198.51.100.0/24"}
              disabled={revoked}
            />
          </Row>
          {isPublic && (
            <Row title="Allowed websites" note="One per line. Use *. to match subdomains. Empty allows any website.">
              <textarea
                className="input mono"
                rows={3}
                value={sites}
                onChange={(e) => setSites(e.target.value)}
                placeholder={"https://www.example.com\nhttps://*.example.com"}
                disabled={revoked}
              />
            </Row>
          )}
          {!revoked && (
            <div className="key-foot">
              <button className="btn primary" disabled={!changed || saving}>
                {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          )}
        </form>
      </Group>

      {!revoked && (
        <Group
          title="Revoke"
          note="Requests using this key fail at once. A revoked key cannot be restored."
          action={
            <button className="btn danger" onClick={revoke}>
              Revoke key
            </button>
          }
        >
          {null}
        </Group>
      )}
    </>
  );
}
