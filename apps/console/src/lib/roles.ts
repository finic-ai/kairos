import type { Role } from "../types/interfaces";

export const ROLES: Role[] = ["member", "admin", "owner"];

export const ROLE_NOTE: Record<Role, string> = {
  member: "Can view and work with data.",
  admin: "Can also manage members and API keys.",
  owner: "Full access, including owners and workspace deletion.",
};
