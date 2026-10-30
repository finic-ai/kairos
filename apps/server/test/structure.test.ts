import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The direction of calls (internal/designs/server-structure.md, section 4.3): a repository runs
 * SQL and imports nothing above it, and the domain types are below the repositories. So a
 * repository or a types file imports only the database schema, the platform, types and other
 * repositories. A type-only import of a request schema is allowed: it is erased, and runs no Zod.
 */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

const all = (folder: string): string[] =>
  readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? all(path) : path.endsWith(".ts") ? [relative(SRC, path)] : [];
  });
const files = all(SRC);

// A table service (services/*.service.ts) is at the level of a repository: it reads and writes one table.
const REPOSITORY =
  /^modules\/[^/]+\/repo\.ts$|^services\/[a-z_]+\.service\.ts$|^platform\/(sql|orm)\.ts$|^repositories\.ts$/;
const TYPES = /^modules\/[^/]+\/types\.ts$|^types\/index\.ts$/;

const imports = (file: string) =>
  [
    ...readFileSync(join(SRC, file), "utf8").matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?\s+from\s+"([^"]+)";/gms),
  ].map((m) => ({ typeOnly: Boolean(m[1]), from: m[2]! }));

/** The file under src that a relative import names. */
const target = (file: string, from: string) => {
  const base = normalize(join(dirname(file), from));
  return files.find((f) => f === `${base}.ts` || f === `${base}/index.ts`) ?? base;
};

const allowed = (file: string, typeOnly: boolean, from: string, below: (path: string) => boolean) => {
  if (!from.startsWith(".")) return from !== "hono" && (typeOnly || from !== "zod");
  const path = target(file, from);
  if (path.startsWith("db/") || path.startsWith("platform/") || below(path)) return true;
  // A request schema, for its inferred types only.
  return typeOnly && /\/schema\.ts$/.test(path);
};

const problems = (kind: RegExp, below: (path: string) => boolean) =>
  files
    .filter((f) => kind.test(f))
    .flatMap((file) =>
      imports(file)
        .filter(({ typeOnly, from }) => !allowed(file, typeOnly, from, below))
        .map(({ from }) => `${file} imports ${from}`),
    );

const modules = [...new Set(files.filter((f) => f.startsWith("modules/")).map((f) => f.split("/")[1]!))];
/** What runs SQL: Drizzle, the schema, and the SQL helpers. Only a repository imports it, for more than its types. */
const DATABASE = /^(drizzle-orm|\.\.?\/.*(db\/schema|db\/relations|platform\/(orm|sql|database)))$/;

describe("one module, one file for each layer", () => {
  it("names the layers of a module repo.ts, route.ts and service.ts, one of each", () => {
    // A second one (log-route.ts, actions-repo.ts) is a second area: make it a module of its own.
    const extra = files.filter(
      (f) => f.startsWith("modules/") && /(repo|route|service)\.ts$/.test(f) && !/\/(repo|route|service)\.ts$/.test(f),
    );
    expect(extra).toEqual([]);
  });

  it("keeps only the layers at the root of a module, and its other files in libs/", () => {
    const LAYERS = /^modules\/[^/]+\/(index|route|service|repo|types|schema)\.ts$|^modules\/[^/]+\/libs\/[^/]+\.ts$/;
    expect(files.filter((f) => f.startsWith("modules/") && !LAYERS.test(f))).toEqual([]);
    const libs = [...new Set(files.filter((f) => f.includes("/libs/")).map((f) => dirname(f)))];
    expect(libs.filter((dir) => !files.includes(`${dir}/index.ts`))).toEqual([]);
  });

  it("imports a module's libs through libs/index.ts, except inside libs/", () => {
    const inside = files.flatMap((file) =>
      imports(file)
        .filter(({ from }) => from.startsWith("."))
        .map(({ from }) => target(file, from))
        .filter((path) => /^modules\/[^/]+\/libs\/(?!index\.ts$)/.test(path) && dirname(path) !== dirname(file))
        .map((path) => `${file} imports ${path}`),
    );
    expect(inside).toEqual([]);
  });

  it("runs SQL only in repo.ts", () => {
    const hidden = files
      .filter((f) => f.startsWith("modules/") && !f.endsWith("/repo.ts"))
      .flatMap((file) =>
        imports(file)
          .filter(({ typeOnly, from }) => !typeOnly && DATABASE.test(from))
          .map(({ from }) => `${file} imports ${from}`),
      );
    expect(hidden).toEqual([]);
  });
});

describe("the direction of calls", () => {
  it("finds the repositories and the types", () => {
    expect(files.filter((f) => REPOSITORY.test(f)).length).toBeGreaterThan(10);
    // One types file for each module, and the index of them all.
    expect(files.filter((f) => TYPES.test(f)).length).toBe(modules.length + 1);
  });

  it("keeps the repositories below the services, the routes and Zod", () => {
    expect(problems(REPOSITORY, (path) => REPOSITORY.test(path) || TYPES.test(path))).toEqual([]);
  });

  it("keeps the domain types below the services, the routes and Zod", () => {
    expect(problems(TYPES, (path) => TYPES.test(path))).toEqual([]);
  });
});
