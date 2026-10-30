import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import type { Plugin } from "vite";
import { docPage, fill, indexPage, type Html } from "./layout";
import { groupPages, groups, pages, slugs } from "./pages";
import { readDoc, readLede, renderDoc, type RenderedDoc, type SearchEntry } from "./render";

type Site = {
  pages: Map<string, Html>;
  markdown: Map<string, string>;
  search: SearchEntry[];
  images: Set<string>;
  missing: string[];
  brokenLinks: string[];
  notForCustomers: string[];
};

/** Words that belong in the Deployment group or in docs/development/, not on a page for customers. */
const NOT_FOR_CUSTOMERS: [RegExp, string][] = [
  [/\bpnpm\b|git clone/, "a command for the repository"],
  [/localhost:(8787|5273)/, "a local server"],
  [/\b(apps|packages|examples)\/[a-z]/, "a path in the repository"],
  [
    /\b(KAIROS_(?!(API_KEY|URL|PROFILE|WEBHOOK_SECRET)\b)[A-Z_]+|SUPABASE_[A-Z_]+|DATABASE_URL|GRAYSON_API_KEY|CRON_SECRET|VITE_[A-Z_]+)/,
    "a server setting",
  ],
];

function customerProblems(slug: string, raw: string): string[] {
  return raw
    .split("\n")
    .flatMap((line, i) =>
      NOT_FOR_CUSTOMERS.filter(([pattern]) => pattern.test(line)).map(
        ([, what]) => `docs/${slug} line ${i + 1}: ${what}: ${line.trim().slice(0, 100)}`,
      ),
    );
}

const operatorPages = new Set(
  groups.filter((g) => g.heading === "Deployment").flatMap((g) => groupPages(g).map((p) => p.slug)),
);

type Route = { kind: "page" | "markdown"; slug: string } | { kind: "search" } | { kind: "image"; path: string };

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

async function buildSite(dir: string): Promise<Site> {
  const site: Site = {
    pages: new Map(),
    markdown: new Map(),
    search: [],
    images: new Set(),
    missing: [],
    brokenLinks: [],
    notForCustomers: [],
  };
  const rendered = new Map<string, RenderedDoc>();
  for (const page of pages) {
    const doc = readDoc(dir, page.slug);
    if (!doc) {
      site.missing.push(page.slug);
      continue;
    }
    const result = await renderDoc(page, doc.file, doc.raw);
    rendered.set(page.slug, result);
    site.pages.set(page.slug, docPage(page, result));
    site.markdown.set(page.slug, doc.raw);
    site.search.push(...result.sections);
    for (const image of result.images) site.images.add(image);
    if (!operatorPages.has(page.slug)) site.notForCustomers.push(...customerProblems(page.slug, doc.raw));
  }
  for (const [slug, result] of rendered) {
    for (const link of result.links) {
      const [target = "", hash] = link.slice("/docs/".length).split("#");
      if (hash && !rendered.get(target)?.ids.includes(hash)) site.brokenLinks.push(`docs/${slug}: ${link}`);
    }
  }
  site.pages.set("", indexPage(readLede(dir)));
  return site;
}

function route(path: string): Route | null {
  if (path === "/docs/search.json") return { kind: "search" };
  const match = /^\/docs(?:\/(.+?))?\/?$/.exec(path);
  if (!match) return null;
  const slug = match[1] ?? "";
  if (IMAGE_TYPES[extname(slug).toLowerCase()]) return { kind: "image", path: slug };
  if (slug.endsWith(".md")) {
    const source = slug.slice(0, -".md".length);
    return slugs.has(source) ? { kind: "markdown", slug: source } : null;
  }
  return slug === "" || slugs.has(slug) ? { kind: "page", slug } : null;
}

function write(file: string, contents: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/**
 * Publishes docs/ at /docs as static pages. The pages and their order are in pages.ts; the
 * template is docs/index.html, which Vite builds as a second entry so that it links the bundled client.
 */
export function docs(): Plugin {
  let root = "";
  let outDir = "";
  let dir = "";
  return {
    name: "kairos-docs",
    configResolved(config) {
      root = config.root;
      outDir = resolve(root, config.build.outDir);
      dir = resolve(root, "../../docs");
    },
    configureServer(server) {
      let site: Promise<Site> | undefined;
      const onChange = (file: string) => {
        if (!file.startsWith(dir)) return;
        site = undefined;
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.add(dir);
      server.watcher.on("change", onChange).on("add", onChange).on("unlink", onChange);

      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? "").split("?")[0]!;
        const target = route(path);
        if (!target) return next();
        try {
          const current = await (site ??= buildSite(dir));
          if (target.kind === "search") {
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify(current.search));
          }
          if (target.kind === "image") {
            if (!current.images.has(target.path)) return next();
            res.setHeader("Content-Type", IMAGE_TYPES[extname(target.path).toLowerCase()]!);
            return res.end(readFileSync(join(dir, target.path)));
          }
          if (target.kind === "markdown") {
            res.setHeader("Content-Type", "text/markdown; charset=utf-8");
            return res.end(current.markdown.get(target.slug));
          }
          const html = current.pages.get(target.slug);
          if (!html) return next();
          const template = readFileSync(join(root, "docs/index.html"), "utf8");
          res.setHeader("Content-Type", "text/html");
          res.end(await server.transformIndexHtml(path, fill(template, html)));
        } catch (cause) {
          next(cause);
        }
      });
    },
    async writeBundle() {
      const site = await buildSite(dir);
      if (site.missing.length) this.error(`pages.ts lists pages with no file in docs/: ${site.missing.join(", ")}`);
      for (const link of site.brokenLinks) this.warn(`link to a heading that does not exist, ${link}`);
      for (const problem of site.notForCustomers) this.warn(problem);

      const template = readFileSync(join(outDir, "docs/index.html"), "utf8");
      for (const [slug, html] of site.pages) write(join(outDir, "docs", slug, "index.html"), fill(template, html));
      for (const [slug, markdown] of site.markdown) write(join(outDir, "docs", `${slug}.md`), markdown);
      write(join(outDir, "docs/search.json"), JSON.stringify(site.search));
      for (const image of site.images) {
        if (!existsSync(join(dir, image))) {
          this.warn(`an image that does not exist: docs/${image}`);
          continue;
        }
        mkdirSync(dirname(join(outDir, "docs", image)), { recursive: true });
        copyFileSync(join(dir, image), join(outDir, "docs", image));
      }
    },
  };
}
