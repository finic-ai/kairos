import { FormEvent, useState } from "react";
import { workspaces } from "../../api/index";
import type { ApiKey } from "../../types/interfaces";
import type { Environment, Workspace } from "../../types/interfaces";
import { Copy } from "../ui/Copy";
import { Modal } from "../ui/Modal";

const splitIps = (text: string) => text.split(/[\s,]+/).filter(Boolean);

export function KeyModal({
  workspace,
  environment,
  onClose,
  onCreated,
  kind: fixed,
  defaultName = "",
}: {
  workspace: Workspace;
  environment: Environment;
  onClose: () => void;
  onCreated: (created: { key: ApiKey; secret: string }) => void;
  /** Make only this kind of key, with no choice. */
  kind?: ApiKey["kind"];
  defaultName?: string;
}) {
  const [name, setName] = useState(defaultName);
  const [kind, setKind] = useState<ApiKey["kind"]>(fixed ?? "secret");
  const [ips, setIps] = useState("");
  const [sites, setSites] = useState("");
  const [created, setCreated] = useState<{ key: ApiKey; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    workspaces
      .createKey(workspace.id, {
        name,
        kind,
        allowed_ips: splitIps(ips),
        allowed_origins: kind === "public" ? splitIps(sites) : [],
      })
      .then(
        (result) => (setCreated(result), onCreated(result)),
        (e: Error) => setError(e.message),
      );
  };
  if (created)
    return (
      <Modal title="Save your key" onClose={onClose}>
        <div className="modal-body">
          <p>
            Copy <b>{created.key.name}</b> and store it somewhere safe. You won't be able to see it again.
          </p>
          <Copy value={created.secret} />
          <div className="modal-foot">
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  return (
    <Modal title="Create API key" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        <p>
          This key will access <b>{environment.name}</b> in {workspace.name}.
        </p>
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        {!fixed && (
          <div className="key-kinds">
            <button
              type="button"
              className={`template ${kind === "secret" ? "on" : ""}`}
              onClick={() => setKind("secret")}
            >
              <b>Secret key</b>
              <span>Server-side. Full API access.</span>
              <small className="mono">ksk_…</small>
            </button>
            <button
              type="button"
              className={`template ${kind === "public" ? "on" : ""}`}
              onClick={() => setKind("public")}
            >
              <b>Public key</b>
              <span>Client-side. Can only send events.</span>
              <small className="mono">kpk_…</small>
            </button>
          </div>
        )}
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === "secret" ? "Production backend" : "Website"}
            maxLength={80}
            required
            autoFocus
          />
        </label>
        {kind === "public" && (
          <label className="field">
            <span>Allowed websites (optional)</span>
            <textarea
              className="input mono"
              rows={2}
              value={sites}
              onChange={(e) => setSites(e.target.value)}
              placeholder={"https://www.example.com\nhttps://*.example.com"}
            />
            <small>One per line. Use *. to match subdomains. Leave empty to allow any website.</small>
          </label>
        )}
        <label className="field">
          <span>Allowed IP addresses (optional)</span>
          <textarea
            className="input mono"
            rows={2}
            value={ips}
            onChange={(e) => setIps(e.target.value)}
            placeholder={"203.0.113.7\n198.51.100.0/24"}
          />
          <small>One IP or IPv4 range per line. Leave empty to allow any address.</small>
        </label>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Create key</button>
        </div>
      </form>
    </Modal>
  );
}
