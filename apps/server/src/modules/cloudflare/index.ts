import type { Tenancy } from "../tenancy/service";
import { cloudflareRoutes, type CloudflareDeps } from "./route";
import { createCloudflare } from "./service";

export function cloudflareModule({
  tenancy,
  fetch: doFetch,
  ...deps
}: Omit<CloudflareDeps, "cloudflare"> & { tenancy: Tenancy; fetch: typeof globalThis.fetch }) {
  return { routes: cloudflareRoutes({ ...deps, cloudflare: createCloudflare({ tenancy, fetch: doFetch }) }) };
}
