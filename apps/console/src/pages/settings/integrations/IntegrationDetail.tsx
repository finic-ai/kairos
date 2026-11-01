import { useState } from "react";
import { Code } from "../../../components/get-started/Code";
import { KeyModal } from "../../../components/settings/KeyModal";
import { href } from "../../../lib/route";
import type { Environment, Workspace } from "../../../types/interfaces";
import { KEY_PLACEHOLDERS, KINDS, type Integration } from "./catalog";
import { Logo } from "./CatalogTab";
import { CloudflareDeployModal } from "./CloudflareDeployModal";

export function IntegrationDetail({
  integration,
  workspace,
  environment,
}: {
  integration: Integration;
  workspace: Workspace;
  environment: Environment;
}) {
  const manage = workspace.role !== "member";
  const [creating, setCreating] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const available = !!integration.docs;
  const kind = integration.key ?? "secret";
  const placeholder = KEY_PLACEHOLDERS[kind];
  const origin = window.location.origin;

  return (
    <>
      <div className="crumbs">
        <a href={href("settings", "integrations")}>Integrations</a>
        <span aria-hidden>/</span>
        <span>{integration.name}</span>
      </div>
      <div className="integration-head">
        <Logo integration={integration} size={48} />
        <h1>{integration.name}</h1>
        {available && manage && (
          <button className="btn" onClick={() => setCreating(true)}>
            Create key
          </button>
        )}
        {integration.slug === "cloudflare" && manage && (
          <button className="btn primary" onClick={() => setDeploying(true)}>
            Deploy Worker
          </button>
        )}
      </div>
      <nav className="tabs">
        <a className="on" href={href("settings", "integrations", integration.slug)}>
          Installation
        </a>
      </nav>

      {!available && (
        <div className="banner info">This integration is coming soon. This page shows what it will do.</div>
      )}

      <div className="integration-body">
        <section>
          <h2 className="integration-label">Overview</h2>
          <div className="card stack" style={{ padding: 18, gap: 12 }}>
            {integration.overview.map((text) => (
              <p key={text} style={{ margin: 0 }}>
                {text}
              </p>
            ))}
            {integration.steps?.map((step, n) => (
              <div key={step.title}>
                <Code
                  title={`${n + 1}. ${step.title}`}
                  text={step.code(secret ?? placeholder, origin)}
                  lang={step.lang}
                />
              </div>
            ))}
            {available && (
              <p className="muted" style={{ margin: 0 }}>
                {secret
                  ? "Copy the key now. It is shown only once."
                  : kind === "public"
                    ? `Replace ${placeholder} with a public key of ${environment.name}, limited to your websites.`
                    : `Replace ${placeholder} with a secret key of ${environment.name}. Keep it on your server.`}
              </p>
            )}
            {integration.plans && (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {integration.plans.map((plan) => (
                  <li key={plan}>{plan}</li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <aside>
          <h2 className="integration-label">Details</h2>
          <div className="card rows">
            <div className="set-row">
              <span>Status</span>
              <span className={`chip ${available ? "accent" : ""}`}>{available ? "Available" : "Coming soon"}</span>
            </div>
            <div className="set-row">
              <span>Kind</span>
              <span className="muted">{KINDS.find((k) => k.id === integration.kind)!.title}</span>
            </div>
            {integration.docs && (
              <div className="set-row">
                <span>Docs</span>
                <a href={integration.docs} target="_blank" rel="noreferrer">
                  Read
                </a>
              </div>
            )}
            {integration.clientSettings && (
              <div className="set-row">
                <span>Settings</span>
                <a href={href("settings", "integrations", "client-settings")}>Client settings</a>
              </div>
            )}
          </div>
        </aside>
      </div>

      {deploying && (
        <CloudflareDeployModal workspace={workspace} environment={environment} onClose={() => setDeploying(false)} />
      )}
      {creating && (
        <KeyModal
          workspace={workspace}
          environment={environment}
          kind={kind}
          defaultName={integration.name}
          onClose={() => setCreating(false)}
          onCreated={(created) => setSecret(created.secret)}
        />
      )}
    </>
  );
}
