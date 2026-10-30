import { z } from "zod";
import { email } from "../auth/schema";

export const role = z.enum(["owner", "admin", "member"]);

export const workspaceBody = z.object({ name: z.string().trim().min(1).max(80) });
export const deleteWorkspaceBody = z.object({ confirm: z.string() });
export const memberBody = z.object({ role });
export const inviteBody = z.object({ email, role: role.default("member") });
export const keyBody = z.object({
  environment_id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(["secret", "public"]),
  allowed_ips: z.array(z.string().trim().min(1)).max(50).default([]),
  allowed_origins: z.array(z.string().trim().min(1)).max(50).default([]),
});

/** How long the workspace keeps its history: 7 days to 10 years, or null for forever. */
export const dataRetentionBody = z.object({ retention_days: z.number().int().min(7).max(3650).nullable() }).strict();
