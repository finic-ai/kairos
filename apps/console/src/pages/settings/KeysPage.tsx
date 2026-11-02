import { useState } from "react";
import { workspaces } from "../../api/index";
import type { ApiKey } from "../../types/interfaces";
import { KeyDetail, KindIcon } from "../../components/settings/KeyDetail";
import { KeyModal } from "../../components/settings/KeyModal";
import { Group } from "../../components/ui/Group";
import { Empty, Loading } from "../../components/ui/states";
import { useApi } from "../../hooks/useApi";
import { dayOf, stamp } from "../../lib/format";
import { go, href } from "../../lib/route";
import type { SettingsPageProps } from "./types";

export function KeysPage({ workspace, environment, id }: SettingsPageProps & { id?: string }) {
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

  if (id && !member) {
    const found = data?.keys.find((k) => k.id === id);
    if (!data) return <Loading />;
    if (!found)
      return (
        <Empty title="No such API key">
          It may be in another environment. <a href={href("settings", "keys")}>Back to API Keys</a>
        </Empty>
      );
    return <KeyDetail workspace={workspace} environment={environment} apiKey={found} onChanged={() => reload()} />;
  }

  return (
    <>
      <h1>API Keys</h1>
      {(error ?? loadError) && <div className="banner">{error ?? loadError?.message}</div>}

      <Group
        note="Create, modify, and revoke API Keys for this workspace."
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
            <Empty title="You don't have access to API Keys">Ask a workspace owner or admin for a key.</Empty>
          ) : !data ? (
            <Loading />
          ) : data.keys.length === 0 ? (
            <Empty title="No API Keys yet">Create a secret key to start sending events from your server.</Empty>
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
                  <tr
                    key={key.id}
                    className={`link ${key.revoked ? "off" : ""}`}
                    onClick={() => go("settings", "keys", key.id)}
                  >
                    <td>
                      <a href={href("settings", "keys", key.id)} onClick={(e) => e.stopPropagation()}>
                        <b>{key.name}</b>
                      </a>
                      <div className="muted">Created {dayOf(key.created)}</div>
                    </td>
                    <td>
                      <span className="key-kind">
                        <KindIcon kind={key.kind} />
                        {key.kind === "public" ? "Public" : "Secret"}
                      </span>
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
                        <button
                          className="btn ghost"
                          onClick={(e) => {
                            e.stopPropagation();
                            revoke(key);
                          }}
                        >
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
          chooseEnvironment
          onClose={() => setCreating(false)}
          onCreated={() => reload()}
        />
      )}
    </>
  );
}
