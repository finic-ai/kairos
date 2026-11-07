import type { Context, MiddlewareHandler } from "hono";
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

type Status = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 429 | 502 | 503;

export const error = (c: Context, status: Status, type: string, message: string) =>
  c.json({ error: { type, message } }, status);

export function rateLimited(c: Context, waitSeconds: number) {
  c.header("Retry-After", String(waitSeconds));
  return error(c, 429, "rate_limited", "Too many requests. Try again later.");
}

export function checked<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw invalid(`${issue.path.join(".") || "body"}: ${issue.message}`);
}

/** Throws when the body cannot be read, as over the size limit, so that the route changes nothing. */
export async function optionalJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
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

/** A body over `max` gives `max + 1` bytes, so the caller can tell. */
export async function readCapped(request: Request, max: number): Promise<Buffer> {
  if (!request.body) return Buffer.alloc(0);
  if (Number(request.headers.get("content-length")) > max) {
    await request.body.cancel().catch(() => {});
    return Buffer.alloc(max + 1);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, max + 1);
}

/** Unlike hono's bodyLimit, this reads nothing ahead: a route that answers first never pulls the body. */
export const limitBody =
  (maxSize: number): MiddlewareHandler =>
  async (c, next) => {
    const body = c.req.raw.body;
    const tooLarge = () => error(c, 413, "too_large", `The body is larger than ${maxSize / 1024 / 1024} MB`);
    if (!body) return next();
    if (Number(c.req.header("content-length")) > maxSize) return tooLarge();
    let size = 0;
    let exceeded = false;
    const reader = body.getReader();
    const counted = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) return controller.close();
        size += value.byteLength;
        if (size > maxSize) {
          exceeded = true;
          await reader.cancel().catch(() => {});
          return controller.error(new Error("The body is too large"));
        }
        controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    c.req.raw = new Request(c.req.raw, { body: counted, duplex: "half" } as RequestInit);
    await next();
    if (exceeded) c.res = tooLarge();
  };

export const bounded = (value: string | undefined, fallback: number, min: number, max: number) =>
  Math.min(Math.max(Math.floor(Number(value)) || fallback, min), max);
