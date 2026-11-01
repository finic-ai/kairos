import { fileURLToPath } from "node:url";

// Set by scripts/build.ts. A server that runs from source bundles the Worker when it first deploys one.
declare const KAIROS_CLOUDFLARE_WORKER: string | undefined;

const ENTRY = 'import { cloudflare } from "@finic-ai/kairos-edge/cloudflare";\nexport default cloudflare();\n';

export async function bundleWorker(): Promise<string> {
  const { build } = await import("esbuild");
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL("../../../..", import.meta.url)), loader: "js" },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    minify: true,
    write: false,
    logLevel: "warning",
  });
  return result.outputFiles[0]!.text;
}

let bundled: Promise<string> | undefined;

export function workerScript(): Promise<string> {
  if (typeof KAIROS_CLOUDFLARE_WORKER === "string") return Promise.resolve(KAIROS_CLOUDFLARE_WORKER);
  return (bundled ??= bundleWorker());
}
