import { useState } from "react";
import { workspaces } from "../../api/index";
import type { Role } from "../../types/interfaces";
import { InviteModal } from "../../components/settings/InviteModal";
import { Group } from "../../components/ui/Group";
import { Loading } from "../../components/ui/states";
import { useMembers } from "../../hooks/useApi";
import { dayOf } from "../../lib/format";
import { ROLES } from "../../lib/roles";
import type { SettingsPageProps } from "./types";

export function MembersPage({ workspace, session, onChange }: SettingsPageProps) {
  const manage = workspace.role !== "member";
  const { data, error: loadError, refetch: reload } = useMembers(workspace.id);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (work: Promise<unknown>, after: () => void = () => {}) =>
    work.then(
      () => (setError(null), after(), reload()),
      (e: Error) => setError(e.message),
    );

  return (
    <>
      <h1>Members</h1>
      {(error ?? loadError) && <div className="banner">{error ?? loadError?.message}</div>}

      <Group
        title="All members"
        note="Everyone with access to this workspace."
        action={
          manage && (
            <button className="btn primary" onClick={() => setInviting(true)}>
              Invite member
            </button>
          )
        }
      >
        <div className="card table-wrap">
          {!data ? (
            <Loading />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th className="hide-md">Joined</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.members.map((member) => {
                  const self = member.id === session.user.id;
                  // Only an owner changes an owner.
                  const editable = manage && (member.role !== "owner" || workspace.role === "owner");
                  return (
                    <tr key={member.id}>
                      <td>
                        <b>{member.name || member.email}</b> {self && <span className="chip">you</span>}
                        <div className="muted">{member.email}</div>
                      </td>
                      <td>
                        {editable ? (
                          <select
                            className="input"
                            style={{ width: "auto" }}
                            value={member.role}
                            onChange={(e) =>
                              run(
                                workspaces.setRole(workspace.id, member.id, e.target.value as Role),
                                self ? onChange : undefined,
                              )
                            }
                          >
                            {ROLES.filter((r) => r !== "owner" || workspace.role === "owner").map((r) => (
                              <option key={r}>{r}</option>
                            ))}
                          </select>
                        ) : (
                          member.role
                        )}
                      </td>
                      <td className="hide-md muted">{dayOf(member.joined)}</td>
                      <td style={{ textAlign: "right" }}>
                        {editable && !self && (
                          <button
                            className="btn ghost"
                            onClick={() =>
                              window.confirm(`Remove ${member.email} from this workspace?`) &&
                              run(workspaces.removeMember(workspace.id, member.id))
                            }
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Group>

      {data && data.invites.length > 0 && (
        <Group title="Pending invites" note="Lost a link? Invite the same email again to get a new one.">
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th className="hide-md">Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.invites.map((invite) => (
                  <tr key={invite.id}>
                    <td>{invite.email}</td>
                    <td>{invite.role}</td>
                    <td className="hide-md muted">{dayOf(invite.expires)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        className="btn ghost"
                        onClick={() => run(workspaces.revokeInvite(workspace.id, invite.id))}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Group>
      )}

      {inviting && <InviteModal workspace={workspace} onClose={() => setInviting(false)} onInvited={reload} />}
    </>
  );
}
