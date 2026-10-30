import { describe, expect, it } from "vitest";
import { coerce, entityRef, pairs, props, timestamp } from "../src/args";
import { ApiError, Client, sessionFrom } from "../src/client";

describe("arguments", () => {
  it("keeps ids as text and types property values", () => {
    expect(pairs(["user=007", "device=d=1"], "Entity")).toEqual({ user: "007", device: "d=1" });
    expect(props(["amount=120.5", "first=true", "zip=02134", "tags=[1,2]", "note=hi"])).toEqual({
      amount: 120.5,
      first: true,
      zip: "02134",
      tags: [1, 2],
      note: "hi",
    });
    expect(coerce("{not json")).toBe("{not json");
  });

  it("refuses what it cannot read", () => {
    expect(() => pairs(["user"], "Entity")).toThrow('Entity "user" must be name=value');
    expect(() => entityRef("user")).toThrow("type:id");
    expect(() => timestamp("yesterday-ish")).toThrow("ISO 8601");
    expect(entityRef("user:a:b")).toEqual({ type: "user", id: "a:b" });
  });
});

describe("client", () => {
  const recording = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const doFetch = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status, headers });
    }) as unknown as typeof fetch;
    return { calls, doFetch };
  };

  it("sends a key as a bearer token, and repeats a query value given as a list", async () => {
    const { calls, doFetch } = recording(200, { entities: [] });
    const client = new Client({ url: "http://kairos.test", apiKey: "ksk_1", session: "s" }, doFetch);
    await client.request("GET", "/v1/entities", { query: { type: "user", prop: ["a:eq:1", "b:gt:2"], q: undefined } });
    expect(calls[0]!.url).toBe("http://kairos.test/v1/entities?type=user&prop=a%3Aeq%3A1&prop=b%3Agt%3A2");
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer ksk_1" });
  });

  it("sends a session with the workspace and the environment", async () => {
    const { calls, doFetch } = recording(200, {});
    const client = new Client(
      { url: "http://kairos.test", session: "tok", workspace: "ws_1", environment: "env_1" },
      doFetch,
    );
    await client.request("POST", "/v1/decide", { body: { action: "a" } });
    expect(calls[0]!.init.headers).toMatchObject({
      Cookie: "kairos_session=tok",
      "X-Kairos-Workspace": "ws_1",
      "X-Kairos-Environment": "env_1",
      "Content-Type": "application/json",
    });
    expect(client.workspacePath()).toBe("/app/workspaces/ws_1");
  });

  it("turns an error of the API into a message", async () => {
    const { doFetch } = recording(404, { error: { type: "unknown_action", message: 'No action "x"' } });
    const error = await new Client({ url: "http://kairos.test", apiKey: "k" }, doFetch)
      .request("POST", "/v1/decide")
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, type: "unknown_action", message: 'No action "x"' });
  });

  it("does not let an API key manage a workspace", () => {
    expect(() => new Client({ url: "http://kairos.test", apiKey: "k" }).workspacePath()).toThrow("email address");
  });

  it("reads the session from the cookie that signing in sets", () => {
    const response = new Response("{}", {
      headers: [["Set-Cookie", "kairos_session=abc123; Path=/; HttpOnly; SameSite=Lax"]],
    });
    expect(sessionFrom(response)).toBe("abc123");
  });
});
