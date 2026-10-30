import { request, workspacePath as ws } from "./client";
import type {
  Activity,
  ActivityFilter,
  ApiKey,
  Invite,
  McpGroup,
  McpSettings,
  Member,
  Role,
  Workspace,
} from "../types/interfaces";

export const workspaces = {
  create: (name: string) => request<Workspace>("POST", "/app/workspaces", { name }),
  rename: (id: string, name: string) => request<unknown>("PATCH", ws(id), { name }),
  mediaHosts: (id: string) => request<{ hosts: string[] }>("GET", `${ws(id)}/media-hosts`),
  setMediaHosts: (id: string, hosts: string[]) =>
    request<{ hosts: string[] }>("PUT", `${ws(id)}/media-hosts`, { hosts }),
  dataRetention: (id: string) => request<{ retention_days: number | null }>("GET", `${ws(id)}/data-retention`),
  setDataRetention: (id: string, retention_days: number | null) =>
    request<{ retention_days: number | null }>("PUT", `${ws(id)}/data-retention`, { retention_days }),
  mcp: (id: string) => request<McpSettings>("GET", `${ws(id)}/mcp`),
  setMcp: (id: string, settings: { enabled: boolean; groups: McpGroup[] }) =>
    request<McpSettings>("PUT", `${ws(id)}/mcp`, settings),
  remove: (id: string, confirm: string) => request<unknown>("DELETE", ws(id), { confirm }),
  members: (id: string) => request<{ members: Member[]; invites: Invite[] }>("GET", `${ws(id)}/members`),
  setRole: (id: string, user: string, role: Role) =>
    request<unknown>("PATCH", `${ws(id)}/members/${encodeURIComponent(user)}`, { role }),
  removeMember: (id: string, user: string) =>
    request<unknown>("DELETE", `${ws(id)}/members/${encodeURIComponent(user)}`),
  invite: (id: string, email: string, role: Role) =>
    request<{ invite: Invite; token: string }>("POST", `${ws(id)}/invites`, { email, role }),
  revokeInvite: (id: string, invite: string) =>
    request<unknown>("DELETE", `${ws(id)}/invites/${encodeURIComponent(invite)}`),
  keys: (id: string) => request<{ keys: ApiKey[] }>("GET", `${ws(id)}/keys`),
  createKey: (
    id: string,
    input: { name: string; kind: "secret" | "public"; allowed_ips: string[]; allowed_origins: string[] },
  ) => request<{ key: ApiKey; secret: string }>("POST", `${ws(id)}/keys`, input),
  revokeKey: (id: string, key: string) =>
    request<{ keys: ApiKey[] }>("DELETE", `${ws(id)}/keys/${encodeURIComponent(key)}`),
  /** A member gets only their own activity, whatever `user` is. */
  activities: (id: string, filter: ActivityFilter = {}) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(filter)) if (v) query.set(k, String(v));
    return request<{ activities: Activity[]; next: string | null }>("GET", `${ws(id)}/activities?${query}`);
  },
};
