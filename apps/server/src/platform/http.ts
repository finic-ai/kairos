import type { Context } from "hono";
import type { z } from "zod";
import type { User } from "../types";
import type { LogActivity } from "./activity";
import { invalid } from "./error";

export type Env = {
  Variables: {
    workspaceId: string;
    environmentId: string;
    publicKey?: boolean;
    apiKey?: { id: string; name: string };
    userId?: string;
    /** A signed-in person's role in the workspace. None for an API key. */
    role?: "owner" | "admin" | "member";
    user: User;
    logActivity: LogActivity;
  };
};

type Status = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 502 | 503;

export const error = (c: Context, status: Status, type: string, message: string) =>
  c.json({ error: { type, message } }, status);

export function checked<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw invalid(`${issue.path.join(".") || "body"}: ${issue.message}`);
}

export async function parse<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<{ data: z.infer<T> } | { response: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (parsed.success) return { data: parsed.data };
  const issue = parsed.error.issues[0]!;
  return { response: error(c, 400, "invalid_request", `${issue.path.join(".") || "body"}: ${issue.message}`) };
}

export const bounded = (value: string | undefined, fallback: number, min: number, max: number) =>
  Math.min(Math.max(Math.floor(Number(value)) || fallback, min), max);
