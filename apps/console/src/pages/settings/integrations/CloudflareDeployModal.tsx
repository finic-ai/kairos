import { useState, type FormEvent } from "react";
import { workspaces } from "../../../api/workspaces";
import { Copy } from "../../../components/ui/Copy";
import { Modal } from "../../../components/ui/Modal";
import type { CloudflareDeployment, CloudflareZone, Environment, Workspace } from "../../../types/interfaces";

const TOKENS = "https://dash.cloudflare.com/profile/api-tokens";

export function CloudflareDeployModal({
  workspace,
  environment,
  onClose,
}: {
  workspace: Workspace;
  environment: Environment;
  onClose: () => void;
}) {
  const [token, setToken] = useState("");
  const [zones, setZones] = useState<CloudflareZone[] | null>(null);
  const [zone, setZone] = useState("");
  const [pattern, setPattern] = useState("");
  const [hashKey, setHashKey] = useState("");
  const [javascript, setJavascript] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deployed, setDeployed] = useState<CloudflareDeployment | null>(null);

  const choose = (id: string, list = zones) => {
    setZone(id);
    const name = list?.find((z) => z.id === id)?.name;
    if (name) setPattern(`${name}/*`);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const work = zones
      ? workspaces
          .deployCloudflare(workspace.id, {
            token: token.trim(),
            zone_id: zone,
            pattern: pattern.trim(),
            ...(hashKey.trim() ? { hash_key: hashKey.trim() } : {}),
            javascript,
            url: window.location.origin,
          })
          .then((result) => (setDeployed(result), setToken("")))
      : workspaces.cloudflareZones(workspace.id, token.trim()).then(({ zones: found }) => {
          setZones(found);
          if (found[0]) choose(found[0].id, found);
        });
    work.catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };

  if (deployed)
    return (
      <Modal title="Worker deployed" onClose={onClose}>
        <div className="modal-body">
          <p>
            The Worker <b>{deployed.script}</b> runs on <b>{deployed.pattern}</b>, with the key{" "}
            <b>{deployed.key.name}</b>.
          </p>
          {deployed.hash_key && (
            <>
              <p>
                Kairos made a hash key for the Worker. If your servers run the Kairos middleware, set the same value as{" "}
                <span className="mono">KAIROS_HASH_KEY</span> on them. You won't be able to see it again.
              </p>
              <Copy value={deployed.hash_key} />
            </>
          )}
          <div className="modal-foot">
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );

  return (
    <Modal title="Deploy the Worker" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <p>
          Kairos puts the Worker on your Cloudflare zone, for <b>{environment.name}</b>. Make an{" "}
          <a href={TOKENS} target="_blank" rel="noreferrer">
            API token
          </a>{" "}
          from the template <b>Edit Cloudflare Workers</b>. Kairos uses it for this deployment only, and does not keep
          it.
        </p>
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <label className="field">
          <span>Cloudflare API token</span>
          <input
            className="input mono"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            required
            autoFocus
          />
        </label>
        {zones && zones.length === 0 && (
          <div className="banner" style={{ margin: 0 }}>
            The token can see no active zone. Give it the zone of your website.
          </div>
        )}
        {zones && zones.length > 0 && (
          <>
            <label className="field">
              <span>Zone</span>
              <select className="input" value={zone} onChange={(e) => choose(e.target.value)}>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name} · {z.account}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Route</span>
              <input className="input mono" value={pattern} onChange={(e) => setPattern(e.target.value)} required />
              <small>The requests that go through the Worker. Every other request goes to your site as before.</small>
            </label>
            <label className="field">
              <span>Hash key (optional)</span>
              <input
                className="input mono"
                type="password"
                value={hashKey}
                onChange={(e) => setHashKey(e.target.value)}
                placeholder="The KAIROS_HASH_KEY of your servers"
                autoComplete="off"
              />
              <small>Leave it empty, and Kairos makes one and shows it once.</small>
            </label>
            <label className={`check ${javascript ? "on" : ""}`}>
              <input type="checkbox" checked={javascript} onChange={(e) => setJavascript(e.target.checked)} />
              Add the JavaScript tag to HTML pages
            </label>
          </>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || (!!zones && !zones.length)}>
            {busy ? "Working…" : zones ? "Deploy" : "Find zones"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
