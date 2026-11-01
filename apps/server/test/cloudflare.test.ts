import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createRepositories, environmentsRepository, tenancyRepository } from "../src/repositories";
import { testDatabase } from "./helpers/database";

const NOW = new Date("2026-11-01T12:00:00Z");
const ZONE = "0123456789abcdef0123456789abcdef";
const database = await testDatabase();

function cloudflareApi() {
  const state = { failUpload: false };
  const calls: { method: string; path: string; auth: string | null; body?: any; form?: Record<string, string> }[] = [];
  const routes: { id: string; pattern: string; script: string }[] = [];
  const answer = (result: unknown, status = 200) =>
    Response.json(
      { success: status < 400, errors: status < 400 ? [] : [{ message: "Authentication error" }], result },
      { status },
    );
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const path = url.pathname.replace("/client/v4", "") + url.search;
    const auth = new Headers(init.headers).get("authorization");
    const call: (typeof calls)[number] = { method: init.method ?? "GET", path, auth };
    if (init.body instanceof FormData) {
      call.form = {};
      for (const name of ["metadata", "worker.js"]) {
        const value = init.body.get(name);
        if (value !== null) call.form[name] = typeof value === "string" ? value : await value.text();
      }
    } else if (init.body) call.body = JSON.parse(String(init.body));
    calls.push(call);
    if (auth !== "Bearer cf_token") return answer(null, 403);
    if (path.startsWith("/zones?"))
      return answer([{ id: ZONE, name: "example.com", account: { id: "acc_1", name: "Shop" } }]);
    if (path === `/zones/${ZONE}`)
      return answer({ id: ZONE, name: "example.com", account: { id: "acc_1", name: "Shop" } });
    if (path.startsWith("/accounts/acc_1/workers/scripts/")) return state.failUpload ? answer(null, 500) : answer({});
    if (path === `/zones/${ZONE}/workers/routes` && call.method === "GET") return answer(routes);
    if (path.startsWith(`/zones/${ZONE}/workers/routes`)) {
      const existing = routes.find((route) => path.endsWith(route.id));
      if (existing) Object.assign(existing, call.body);
      else routes.push({ id: `route_${routes.length + 1}`, ...call.body });
      return answer({});
    }
    return answer(null, 404);
  }) as typeof globalThis.fetch;
  return { calls, routes, fetch, state };
}

let app: ReturnType<typeof createApp>;
let cloudflare: ReturnType<typeof cloudflareApi>;

beforeEach(async () => {
  await database.reset({ key_a: "workspace_a" });
  cloudflare = cloudflareApi();
  app = createApp({
    repos: createRepositories(database.db),
    environments: environmentsRepository(database.db),
    accounts: tenancyRepository(database.db),
    decider: async () => ({ id: "dec_1", model: "grayson-1", answers: {}, usage: { input_tokens: 1 } }),
    fetch: cloudflare.fetch,
    now: () => NOW,
  });
});

async function owner() {
  const response = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "correct horse", name: "Owner" }),
  });
  const profile = (await response.json()) as any;
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  const workspace = profile.workspaces[0].id as string;
  const post = (path: string, body: unknown) =>
    app.request(`/app/workspaces/${workspace}${path}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const keys = async () =>
    (
      (await (await app.request(`/app/workspaces/${workspace}/keys`, { headers: { Cookie: cookie } })).json()) as any
    ).keys.filter((key: any) => key.name.startsWith("Cloudflare")) as any[];
  return { post, keys };
}

describe("deploying the Cloudflare Worker", () => {
  it("lists the zones of a token, and says when Cloudflare refuses it", async () => {
    const { post } = await owner();
    expect(await (await post("/cloudflare/zones", { token: "cf_token" })).json()).toEqual({
      zones: [{ id: ZONE, name: "example.com", account: "Shop" }],
    });
    const refused = await post("/cloudflare/zones", { token: "wrong" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as any).error.message).toBe(
      "Cloudflare refused the token. Make an API token from the template Edit Cloudflare Workers, for your zone. Cloudflare: Authentication error",
    );
  });

  it("uploads the Worker with a new key, routes it, and revokes the keys of the deployment before", async () => {
    const { post, keys } = await owner();
    const deploy = (body: object = {}) =>
      post("/cloudflare/deploy", {
        token: "cf_token",
        zone_id: ZONE,
        pattern: "example.com/*",
        url: "https://kairos.example.org",
        ...body,
      });

    const first = (await (await deploy({ javascript: true })).json()) as any;
    expect(first).toMatchObject({ script: "kairos-production", zone: "example.com", pattern: "example.com/*" });
    expect(first.hash_key).toMatch(/^[a-f0-9]{64}$/);
    const upload = cloudflare.calls.find((call) => call.method === "PUT" && call.path.startsWith("/accounts/"))!;
    expect(upload.path).toBe("/accounts/acc_1/workers/scripts/kairos-production");
    const metadata = JSON.parse(upload.form!.metadata!);
    expect(metadata.main_module).toBe("worker.js");
    expect(metadata.bindings.map((b: any) => [b.type, b.name])).toEqual([
      ["secret_text", "KAIROS_API_KEY"],
      ["secret_text", "KAIROS_HASH_KEY"],
      ["plain_text", "KAIROS_URL"],
      ["plain_text", "KAIROS_PUBLIC_KEY"],
    ]);
    expect(metadata.bindings[0].text).toMatch(/^ksk_/);
    expect(metadata.bindings[1].text).toBe(first.hash_key);
    expect(metadata.bindings[3].text).toMatch(/^kpk_/);
    expect(upload.form!["worker.js"]).toContain("export");
    expect(cloudflare.routes).toEqual([{ id: "route_1", pattern: "example.com/*", script: "kairos-production" }]);

    const second = (await (await deploy({ hash_key: "the-hash-key-of-my-servers" })).json()) as any;
    expect(second.hash_key).toBeUndefined();
    expect(cloudflare.routes).toHaveLength(1);
    const live = (await keys()).filter((key) => !key.revoked).map((key) => [key.name, key.kind, key.allowed_origins]);
    expect(live).toEqual([["Cloudflare Worker · example.com", "secret", []]]);
    expect((await keys()).find((key) => key.id === first.public_key.id).revoked).toBeTruthy();
  });

  it("refuses a route of another zone, and revokes its new keys when Cloudflare fails", async () => {
    const { post, keys } = await owner();
    const outside = await post("/cloudflare/deploy", { token: "cf_token", zone_id: ZONE, pattern: "other.com/*" });
    expect(outside.status).toBe(400);
    expect(await keys()).toEqual([]);

    cloudflare.state.failUpload = true;
    const failed = await post("/cloudflare/deploy", { token: "cf_token", zone_id: ZONE, pattern: "example.com/*" });
    expect(failed.status).toBe(502);
    expect((await keys()).map((key) => [key.name, !!key.revoked])).toEqual([["Cloudflare Worker · example.com", true]]);
  });
});
