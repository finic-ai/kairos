import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The Postgres the tests run against. Each test file makes its own database in it. */
    postgresUrl: string;
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

/**
 * One Postgres for the whole run: KAIROS_TEST_DATABASE_URL if it is set, or else a
 * throwaway embedded one that is removed when the run ends.
 */
export default async function setup(project: TestProject) {
  if (process.env.KAIROS_TEST_DATABASE_URL) {
    project.provide("postgresUrl", process.env.KAIROS_TEST_DATABASE_URL);
    return;
  }
  // The package belongs to the server, and this file is loaded from the root of the repository: find it from here.
  const entry = createRequire(import.meta.url).resolve("embedded-postgres");
  const { default: EmbeddedPostgres } = (await import(pathToFileURL(entry).href)) as typeof import("embedded-postgres");
  const dir = mkdtempSync(join(tmpdir(), "kairos-test-pg-"));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: "kairos",
    password: "kairos",
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();
  project.provide("postgresUrl", `postgres://kairos:kairos@localhost:${port}/postgres`);
  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
