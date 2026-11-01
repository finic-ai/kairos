import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { Marked, Renderer, type Token, type Tokens } from "marked";
import { createHighlighter, type Highlighter } from "shiki";
import { contextOf, slugs, type DocPage } from "./pages";

export type TocEntry = { id: string; text: string; depth: 2 | 3 };
export type SearchEntry = { slug: string; page: string; title: string; id: string; text: string };
export type RenderedDoc = {
  title: string;
  titleHtml: string;
  html: string;
  toc: TocEntry[];
  ids: string[];
  links: string[];
  /** Images the page shows, as paths in docs/. */
  images: string[];
  sections: SearchEntry[];
};

const LANGS = ["bash", "csv", "html", "http", "javascript", "json", "nginx", "python", "toml", "typescript"];
const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  js: "javascript",
  ts: "typescript",
  py: "python",
};
const THEMES = { light: "github-light", dark: "github-dark" };

let highlighter: Promise<Highlighter> | undefined;
const getHighlighter = () => (highlighter ??= createHighlighter({ themes: Object.values(THEMES), langs: LANGS }));

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The markdown of a published slug: `docs/<slug>.md`, or the README.md of the folder `docs/<slug>`. */
export function readDoc(dir: string, slug: string): { file: string; raw: string } | null {
  if (!slugs.has(slug)) return null;
  for (const file of [`${slug}.md`, `${slug}/README.md`]) {
    // Comments are notes for people who edit the file, such as "generated from …".
    if (existsSync(join(dir, file)))
      return { file, raw: readFileSync(join(dir, file), "utf8").replace(/<!--[\s\S]*?-->\n*/g, "") };
  }
  return null;
}

export function readLede(dir: string): string {
  const raw = readFileSync(join(dir, "README.md"), "utf8");
  const paragraph = new Marked().lexer(raw).find((t): t is Tokens.Paragraph => t.type === "paragraph");
  return paragraph ? plainText(paragraph.text) : "";
}

function plainText(markdown: string): string {
  return markdown
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*|\*([^*]+)\*/g, "$1$2")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

/** The anchors that GitHub gives headings, so that links written for the repository work here too. */
function slugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = plainText(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

/**
 * A link to a published page goes to that page. A link to any other file of the repository is
 * dropped and keeps its text, because the repository is private.
 */
function resolveLink(href: string, file: string): string | null | undefined {
  if (/^[a-z][a-z0-9+.-]*:|^\//i.test(href)) return undefined;
  const [target = "", hash] = href.split("#");
  const resolved = target ? posix.normalize(posix.join(posix.dirname(file), target)) : file;
  if (!resolved.endsWith(".md")) return null;
  const slug = resolved.slice(0, -".md".length).replace(/(^|\/)README$/, "");
  if (!slugs.has(slug)) return null;
  return `/docs/${slug}${hash ? `#${hash}` : ""}`;
}

function sectionText(tokens: Token[]): string {
  return plainText(tokens.map((t) => t.raw).join(" "))
    .replace(/[|#>*]/g, " ")
    .replace(/-{2,}/g, " ")
    .replace(/(^|\s)- /g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export async function renderDoc(page: DocPage, file: string, raw: string): Promise<RenderedDoc> {
  const hl = await getHighlighter();
  const marked = new Marked({ gfm: true });
  const tokens = marked.lexer(raw);

  const h1 = tokens.findIndex((t) => t.type === "heading" && t.depth === 1);
  const titleToken = h1 >= 0 ? (tokens.splice(h1, 1)[0] as Tokens.Heading) : undefined;
  const title = titleToken ? plainText(titleToken.text) : page.title;
  const titleHtml = titleToken ? marked.parseInline(titleToken.text, { async: false }) : escapeHtml(page.title);

  const slug = slugger();
  const headingIds = new WeakMap<Token, string>();
  const toc: TocEntry[] = [];
  const sections: SearchEntry[] = [];
  let section = { title, id: "", tokens: [] as Token[] };
  const flush = () =>
    sections.push({
      slug: page.slug,
      page: [contextOf(page), page.title].filter(Boolean).join(" › "),
      title: section.title,
      id: section.id,
      text: sectionText(section.tokens),
    });

  for (const t of tokens) {
    if (t.type === "heading") {
      const id = slug(t.text);
      headingIds.set(t, id);
      if (t.depth === 2 || t.depth === 3) {
        toc.push({ id, text: plainText(t.text), depth: t.depth });
        flush();
        section = { title: plainText(t.text), id, tokens: [] };
      }
    } else if (t.type !== "code" && t.type !== "space") {
      section.tokens.push(t);
    }
  }
  flush();

  const links: string[] = [];
  const images: string[] = [];
  marked.use({
    renderer: {
      heading(token) {
        const id = headingIds.get(token) ?? slug(token.text);
        const inner = this.parser.parseInline(token.tokens);
        return `<h${token.depth} id="${id}">${inner}<a class="docs-anchor" href="#${id}" aria-label="Link to this section">#</a></h${token.depth}>\n`;
      },
      link(token) {
        const href = resolveLink(token.href, file);
        if (href === undefined) return false;
        const inner = this.parser.parseInline(token.tokens);
        if (href === null) return inner;
        links.push(href);
        return `<a href="${escapeHtml(href)}">${inner}</a>`;
      },
      image(token) {
        if (/^[a-z][a-z0-9+.-]*:|^\//i.test(token.href)) return false;
        const path = posix.normalize(posix.join(posix.dirname(file), token.href));
        if (path.startsWith("..")) return escapeHtml(token.text);
        images.push(path);
        return `<img src="/docs/${escapeHtml(path)}" alt="${escapeHtml(token.text)}" loading="lazy" />`;
      },
      code(token) {
        const lang = ALIASES[token.lang ?? ""] ?? token.lang ?? "";
        const highlighted = hl.codeToHtml(token.text, {
          lang: LANGS.includes(lang) ? lang : "text",
          themes: THEMES,
          defaultColor: false,
        });
        return `<div class="docs-code">${highlighted}<button type="button" class="docs-copy" aria-label="Copy code"></button></div>\n`;
      },
      table(token) {
        return `<div class="docs-table">${Renderer.prototype.table.call(this, token)}</div>\n`;
      },
    },
  });
  const html = marked.parser(tokens);
  const ids = [...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1]!);
  return { title, titleHtml, html, toc, ids, links, images, sections };
}
