import { randomBytes } from "node:crypto";
import { AppError, invalid } from "../../platform/error";
import type { Environment } from "../environments/types";
import type { Tenancy } from "../tenancy/service";
import { workerScript } from "./libs";
import type { DeployInput, Zone } from "./types";

const API = "https://api.cloudflare.com/client/v4";
const COMPATIBILITY_DATE = "2025-09-01";
const HOSTED = "https://kairos.finic.ai";
const TOKEN_REFUSED =
  "Cloudflare refused the token. Make an API token from the template Edit Cloudflare Workers, for your zone.";

type Binding = { type: "secret_text" | "plain_text"; name: string; text: string };

/** The Cloudflare API with one token, which is used for these calls only and never kept. */
function cloudflare(token: string, doFetch: typeof fetch) {
  const call = async <T>(method: string, path: string, body?: FormData | object, refused?: string): Promise<T> => {
    let response: Response;
    try {
      response = await doFetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
      });
    } catch {
      throw new AppError("bad_gateway", "cloudflare_unavailable", "Cloudflare could not be reached.");
    }
    const data = (await response.json().catch(() => null)) as {
      success?: boolean;
      errors?: { message: string }[];
      result?: T;
    } | null;
    if (response.ok && data?.success) return data.result as T;
    const said = data?.errors?.[0]?.message ?? `it answered ${response.status}`;
    if (response.status >= 500) throw new AppError("bad_gateway", "cloudflare_unavailable", `Cloudflare: ${said}`);
    throw new AppError(
      "invalid",
      "cloudflare_refused",
      refused ? `${refused} Cloudflare: ${said}` : `Cloudflare: ${said}`,
    );
  };

  return {
    zones: () => call<Zone[]>("GET", "/zones?per_page=50&status=active", undefined, TOKEN_REFUSED),
    zone: (id: string) => call<Zone>("GET", `/zones/${id}`, undefined, TOKEN_REFUSED),
    upload(account: string, name: string, script: string, bindings: Binding[]) {
      const form = new FormData();
      const metadata = { main_module: "worker.js", compatibility_date: COMPATIBILITY_DATE, bindings };
      form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
      form.append("worker.js", new Blob([script], { type: "application/javascript+module" }), "worker.js");
      return call<unknown>("PUT", `/accounts/${account}/workers/scripts/${name}`, form);
    },
    async route(zone: string, pattern: string, script: string) {
      const routes = await call<{ id: string; pattern: string }[]>("GET", `/zones/${zone}/workers/routes`);
      const same = routes.find((route) => route.pattern === pattern);
      return same
        ? call<unknown>("PUT", `/zones/${zone}/workers/routes/${same.id}`, { pattern, script })
        : call<unknown>("POST", `/zones/${zone}/workers/routes`, { pattern, script });
    },
  };
}

// One Worker for each environment; it can run on several zones.
const scriptName = (environment: Environment) =>
  `kairos-${environment.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`.slice(0, 63);

function inZone(pattern: string, zone: string): boolean {
  const host = pattern.split("/")[0]!.replace(/^\*\.?/, "");
  return pattern.includes("/") && (host === zone || host.endsWith(`.${zone}`));
}

export function createCloudflare({ tenancy, fetch: doFetch }: { tenancy: Tenancy; fetch: typeof fetch }) {
  return {
    zones: (token: string) => cloudflare(token, doFetch).zones(),

    async deploy(workspace: string, userId: string, environment: Environment, input: DeployInput) {
      const api = cloudflare(input.token, doFetch);
      const zone = await api.zone(input.zone_id);
      if (!inZone(input.pattern, zone.name))
        throw invalid(`pattern: "${input.pattern}" is not a route of ${zone.name}, such as ${zone.name}/*`);
      const name = scriptName(environment);
      const keyName = `Cloudflare Worker · ${zone.name}`;
      const tagName = `${keyName} · JavaScript`;
      const earlier = (await tenancy.keys(workspace, environment.id)).filter(
        (key) => !key.revoked && (key.name === keyName || key.name === tagName),
      );

      const create = (kind: "secret" | "public", keyTitle: string, origins: string[]) =>
        tenancy.createKey(workspace, userId, {
          name: keyTitle,
          kind,
          allowed_ips: [],
          allowed_origins: origins,
          environment_id: environment.id,
        });
      const secret = await create("secret", keyName, []);
      const tag = input.javascript
        ? await create("public", tagName, [`https://${zone.name}`, `https://*.${zone.name}`])
        : undefined;
      const hashKey = input.hash_key ?? randomBytes(32).toString("hex");
      const url = input.url?.replace(/\/+$/, "");
      try {
        await api.upload(zone.account.id, name, await workerScript(), [
          { type: "secret_text", name: "KAIROS_API_KEY", text: secret.secret },
          { type: "secret_text", name: "KAIROS_HASH_KEY", text: hashKey },
          ...(url && url !== HOSTED ? [{ type: "plain_text" as const, name: "KAIROS_URL", text: url }] : []),
          ...(tag ? [{ type: "plain_text" as const, name: "KAIROS_PUBLIC_KEY", text: tag.secret }] : []),
        ]);
        await api.route(zone.id, input.pattern, name);
      } catch (cause) {
        for (const made of [secret, tag]) if (made) await tenancy.revokeKey(workspace, environment.id, made.key.id);
        throw cause;
      }
      for (const key of earlier) await tenancy.revokeKey(workspace, environment.id, key.id);
      return {
        script: name,
        zone: zone.name,
        pattern: input.pattern,
        key: secret.key,
        ...(tag ? { public_key: tag.key } : {}),
        ...(input.hash_key ? {} : { hash_key: hashKey }),
      };
    },
  };
}

export type Cloudflare = ReturnType<typeof createCloudflare>;
