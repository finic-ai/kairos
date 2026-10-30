import { useState } from "react";
import { workspaces } from "../../api/index";
import type { ApiKey } from "../../types/interfaces";
import { KeyModal } from "../../components/settings/KeyModal";
import { Group } from "../../components/ui/Group";
import { Empty, Loading } from "../../components/ui/states";
import { useApi } from "../../hooks/useApi";
import { dayOf, stamp } from "../../lib/format";
import type { SettingsPageProps } from "./types";

export function KeysPage({ workspace, environment }: SettingsPageProps) {
  const member = workspace.role === "member";
  const {
    data,
    error: loadError,
    refetch: reload,
  } = useApi(["keys", workspace.id, member], () =>
    member ? Promise.resolve({ keys: [] as ApiKey[] }) : workspaces.keys(workspace.id),
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const revoke = (key: ApiKey) =>
    window.confirm(`Revoke "${key.name}"? Requests using this key will fail immediately.`) &&
    workspaces.revokeKey(workspace.id, key.id).then(
      () => reload(),
      (e: Error) => setError(e.message),
    );

  return (
    <>
      <h1>API keys</h1>
      {(error ?? loadError) && <div className="banner">{error ?? loadError?.message}</div>}

      <Group
        title={`Keys for ${environment.name}`}
        note="Each key selects its environment automatically. Secret keys have full API access within that environment. Public keys can only send events."
        action={
          !member && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              Create key
            </button>
          )
        }
      >
        <div className="card table-wrap">
          {member ? (
            <Empty title="You don't have access to API keys">Ask a workspace owner or admin for a key.</Empty>
          ) : !data ? (
            <Loading />
          ) : data.keys.length === 0 ? (
            <Empty title="No API keys yet">Create a secret key to start sending events from your server.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Key</th>
                  <th className="hide-md">Restrictions</th>
                  <th className="hide-md">Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.keys.map((key) => (
                  <tr key={key.id} className={key.revoked ? "off" : ""}>
                    <td>
                      <b>{key.name}</b>
                      <div className="muted">Created {dayOf(key.created)}</div>
                    </td>
                    <td>
                      <span className={`chip ${key.kind === "public" ? "accent" : ""}`}>{key.kind}</span>
                    </td>
                    <td className="mono">{key.hint}</td>
                    <td className="hide-md mono">
                      {key.allowed_origins.map((origin) => (
                        <div key={origin}>{origin}</div>
                      ))}
                      {key.allowed_ips.map((ip) => (
                        <div key={ip}>{ip}</div>
                      ))}
                      {key.allowed_origins.length + key.allowed_ips.length === 0 && <span className="muted">none</span>}
                    </td>
                    <td className="hide-md muted">{key.last_used ? stamp(key.last_used) : "Never"}</td>
                    <td style={{ textAlign: "right" }}>
                      {key.revoked ? (
                        <span className="muted">Revoked {dayOf(key.revoked)}</span>
                      ) : (
                        <button className="btn ghost" onClick={() => revoke(key)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Group>

      {creating && (
        <KeyModal
          workspace={workspace}
          environment={environment}
          onClose={() => setCreating(false)}
          onCreated={() => reload()}
        />
      )}
    </>
  );
}
