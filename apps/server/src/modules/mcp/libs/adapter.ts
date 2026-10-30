import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Context } from "hono";
import type { Env } from "../../../platform/http";
import type { RouteRequest } from "./tools";

export interface FetchApp {
  fetch: (request: Request, env?: unknown) => Response | Promise<Response>;
}

/** Past this, the text is cut: a long answer fills the agent's context and costs it more than it gives. */
export const MAX_RESULT_CHARS = 100_000;

/**
 * Sends one `/v1` request into the app, as the agent's key. Only the headers set here reach it,
 * and `c.env` is the original, so the key's IP limit sees the agent's own address.
 */
export async function callRoute(
  app: FetchApp,
  c: Context<Env>,
  route: RouteRequest,
  trustProxy: boolean,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(route.path, c.req.url);
  for (const [name, value] of Object.entries(route.query ?? {}))
    if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  const headers: Record<string, string> = { authorization: c.req.header("authorization")! };
  if (route.body !== undefined) headers["content-type"] = "application/json";
  const forwarded = c.req.header("x-forwarded-for");
  if (trustProxy && forwarded) headers["x-forwarded-for"] = forwarded;
  const response = await app.fetch(
    new Request(url, {
      method: route.method,
      headers,
      ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
    }),
    c.env,
  );
  return { status: response.status, body: await response.json().catch(() => null) };
}

export function toResult(
  status: number,
  body: unknown,
  environment: string,
  trim?: (body: unknown) => unknown,
): CallToolResult {
  if (status < 200 || status >= 300) {
    const failure = (body as { error?: { type?: string; message?: string } } | null)?.error;
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: { type: failure?.type ?? "error", message: failure?.message ?? `The request failed (${status})` },
          }),
        },
      ],
    };
  }
  const data = trim ? trim(body) : body;
  const named =
    data && typeof data === "object" && !Array.isArray(data) ? { environment, ...data } : { environment, data };
  let text = JSON.stringify(named);
  if (text.length > MAX_RESULT_CHARS)
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n[Cut: ${text.length - MAX_RESULT_CHARS} more characters. Ask for fewer rows, or for one item.]`;
  return { content: [{ type: "text", text }] };
}
