/**
 * Build the server to one JavaScript file, with what it reads at run time next to it.
 *
 *   pnpm build:standalone   →  apps/server/dist       `node migrate.mjs`, then `node server.mjs` (and `node worker.mjs`
 *                                                     with KAIROS_WORKER=separate); the Docker image is this directory
 *   pnpm build:vercel       →  .vercel/output         the Build Output API of Vercel: static files and one function
 *
 * Both need the console built first (apps/console/dist); the root scripts do that.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleWorker } from "../src/modules/cloudflare/libs";

const server = fileURLToPath(new URL("..", import.meta.url));
const root = join(server, "../..");
const consoleDist = join(root, "apps/console/dist");
if (!existsSync(join(consoleDist, "index.html"))) {
  console.error("The console is not built. Run this through `pnpm build:standalone` or `pnpm build:vercel`.");
  process.exit(1);
}

const worker = await bundleWorker();

async function bundle(entry: string, outfile: string) {
  await build({
    entryPoints: [join(server, "src", entry)],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    // The embedded Postgres is for a machine with no Postgres; a deployment has DATABASE_URL.
    // The other two are optional parts of pg that are not installed.
    external: ["embedded-postgres", "pg-native", "pg-cloudflare", "esbuild"],
    define: { KAIROS_CLOUDFLARE_WORKER: JSON.stringify(worker) },
    // pg is CommonJS and calls require() for the Node built-ins.
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
    },
    logLevel: "warning",
  });
}

/** The files the server reads when it starts: the SQL migrations and the templates. */
function copyRuntimeFiles(to: string) {
  cpSync(join(server, "drizzle"), join(to, "drizzle"), { recursive: true });
  cpSync(join(root, "templates/actions"), join(to, "templates/actions"), { recursive: true });
  cpSync(join(root, "templates/webhooks"), join(to, "templates/webhooks"), { recursive: true });
  cpSync(join(root, "templates/entities"), join(to, "templates/entities"), { recursive: true });
  cpSync(join(root, "templates/case-views"), join(to, "templates/case-views"), { recursive: true });
}

if (process.argv.includes("--vercel")) {
  const out = join(root, ".vercel/output");
  const fn = join(out, "functions/api.func");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(fn, { recursive: true });

  await bundle("vercel.ts", join(fn, "index.mjs"));
  copyRuntimeFiles(fn);
  writeFileSync(
    join(fn, ".vc-config.json"),
    JSON.stringify(
      {
        runtime: "nodejs22.x",
        handler: "index.mjs",
        launcherType: "Nodejs",
        shouldAddHelpers: false,
        supportsResponseStreaming: true,
        maxDuration: 60,
      },
      null,
      2,
    ),
  );

  cpSync(consoleDist, join(out, "static"), { recursive: true });
  // Background work, such as the retries of outbound webhooks: Vercel Cron calls the drain route with CRON_SECRET. Only
  // when the project has that secret, because the route is closed without it, and because the
  // Hobby plan refuses a deployment with a cron that runs more than once a day: such a project
  // sets KAIROS_CRON_SCHEDULE to a daily one, or leaves CRON_SECRET out (see docs/deployment/self-hosting.md).
  const cron = process.env.CRON_SECRET ? process.env.KAIROS_CRON_SCHEDULE || "* * * * *" : undefined;
  // The server refuses a shorter one when it starts; say so now, not after the deployment.
  if (process.env.CRON_SECRET && process.env.CRON_SECRET.length < 16) {
    console.error("CRON_SECRET must be at least 16 characters. Make one with: openssl rand -hex 32");
    process.exit(1);
  }
  writeFileSync(
    join(out, "config.json"),
    JSON.stringify(
      {
        version: 3,
        routes: [
          {
            src: "^/assets/(.*)$",
            headers: { "Cache-Control": "public, max-age=31536000, immutable" },
            continue: true,
          },
          // The same paths that the console's development server sends to the API, and the scheduler's.
          { src: "^/(?:health|mcp|(?:v1|auth|app|internal)/.*)$", dest: "/api" },
          // Each page of the documentation is docs/<page>/index.html.
          { src: "^/docs((?:/[\\w-]+)*)/?$", dest: "/docs$1/index.html" },
          { handle: "filesystem" },
        ],
        ...(cron ? { crons: [{ path: "/internal/jobs/drain", schedule: cron }] } : {}),
      },
      null,
      2,
    ),
  );
  console.log(
    `Built .vercel/output${cron ? ` with the webhook cron "${cron}"` : " (no webhook cron: CRON_SECRET is not set)"}`,
  );
} else {
  const out = join(server, "dist");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  await bundle("index.ts", join(out, "server.mjs"));
  await bundle("worker.ts", join(out, "worker.mjs"));
  await bundle("migrate.ts", join(out, "migrate.mjs"));
  copyRuntimeFiles(out);
  cpSync(consoleDist, join(out, "console"), { recursive: true });
  console.log("Built apps/server/dist");
}
