import type { User } from "../auth/types";

export type Role = "owner" | "admin" | "member";
export type KeyKind = "secret" | "public";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  created: string;
}

export interface Member extends User {
  role: Role;
  status: "active" | "suspended";
  joined: string;
}

export interface Invite {
  id: string;
  workspace_id: string;
  email: string;
  role: Role;
  invited_by: string;
  created: string;
  expires: string;
}

export interface ApiKey {
  id: string;
  environment_id: string;
  workspace_id: string;
  name: string;
  /** A secret key can do everything. A public key can only send events. */
  kind: KeyKind;
  /** Enough of the key to recognise it. The key itself is shown once and never stored. */
  hint: string;
  /** IP addresses and IPv4 ranges the key may be used from. Empty means anywhere. */
  allowed_ips: string[];
  /** Websites (origins) a public key may be used on. Empty means any. */
  allowed_origins: string[];
  created: string;
  created_by: string | null;
  last_used: string | null;
  revoked: string | null;
}
