import { groupPages, groups, isSection, pages, contextOf, type DocItem, type DocPage } from "./pages";
import { escapeHtml, type RenderedDoc } from "./render";

export type Html = { head: string; body: string };

const ICON_SEARCH = `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="m13.2 13.2 3.3 3.3"/></svg>`;
const ICON_MENU = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 6h13M3.5 10h13M3.5 14h13"/></svg>`;
const ICON_CHEVRON = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 5.5 4.5 4.5L8 14.5"/></svg>`;
const ICON_COPY = `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9.5" height="9.5" rx="2"/><path d="M4 13V5.5A1.5 1.5 0 0 1 5.5 4H13"/></svg>`;

const href = (slug: string) => `/docs/${slug}`;

/** "Webhooks › Inbound" for a page in a section, where the page's own title says too little. */
const fullTitle = (p: DocPage) => {
  const section = contextOf(p);
  return section ? `${section} › ${p.title}` : p.title;
};

// Inline, straight after the sidebar, so that what was opened or closed, and the scroll, are restored before the first paint.
const keepSidebarScroll = `<script>
  (function () {
    var side = document.querySelector(".docs-side");
    var states = {};
    try { states = JSON.parse(sessionStorage.getItem("kairos.docs.open") || "{}"); } catch (e) {}
    side.querySelectorAll("details[data-id]").forEach(function (d) {
      var id = d.getAttribute("data-id");
      if (id in states && !d.querySelector("a.active")) d.open = states[id];
      d.addEventListener("toggle", function () {
        states[id] = d.open;
        try { sessionStorage.setItem("kairos.docs.open", JSON.stringify(states)); } catch (e) {}
      });
    });
    try { side.scrollTop = Number(sessionStorage.getItem("kairos.docs.side")) || 0; } catch (e) {}
    var active = side.querySelector("a.active");
    if (active && (active.offsetTop < side.scrollTop || active.offsetTop > side.scrollTop + side.clientHeight - 40)) {
      side.scrollTop = active.offsetTop - side.clientHeight / 2;
    }
    addEventListener("pagehide", function () {
      try { sessionStorage.setItem("kairos.docs.side", String(side.scrollTop)); } catch (e) {}
    });
  })();
</script>`;

function head(title: string, description: string, markdown?: string): string {
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    markdown ? `<link rel="alternate" type="text/markdown" href="${markdown}" />` : "",
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`,
    `<link rel="icon" type="image/png" href="/favicon-48x48.png" />`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
  ].join("\n    ");
}

function header(current?: DocPage): string {
  const section = current && contextOf(current);
  const crumb = current
    ? `<a href="/docs">Docs</a><span>/</span>${section ? `${escapeHtml(section)}<span>/</span>` : ""}<b>${escapeHtml(current.title)}</b>`
    : `<b>Docs</b>`;
  return `<header class="docs-top">
  <button type="button" class="docs-icon-button docs-menu" aria-label="Open the menu" aria-expanded="false">${ICON_MENU}</button>
  <a class="docs-brand" href="/docs"><i></i>Kairos</a>
  <nav class="docs-crumb" aria-label="Breadcrumb">${crumb}</nav>
  <button type="button" class="docs-search-open">${ICON_SEARCH}<span>Search</span><kbd>⌘K</kbd></button>
  <a class="docs-console" href="/">Open console</a>
</header>`;
}

function sidebar(current?: DocPage): string {
  const link = (p: DocPage) =>
    `<a href="${href(p.slug)}"${p.slug === current?.slug ? ` class="active" aria-current="page"` : ""}>${escapeHtml(p.title)}</a>`;
  const page = (p: DocPage) => {
    if (!p.children) return link(p);
    const open = p.expanded || p === current || p.children.includes(current!);
    return `<details class="docs-section docs-parent" data-id="${p.slug}"${open ? " open" : ""}><summary>${link(p)}<span class="docs-toggle" aria-hidden="true">${ICON_CHEVRON}</span></summary><div class="docs-sub">${p.children.map(link).join("")}</div></details>`;
  };
  const item = (i: DocItem) =>
    isSection(i)
      ? `<details class="docs-section" data-id="${escapeHtml(i.section)}" open><summary>${escapeHtml(i.section)}${ICON_CHEVRON}</summary>${i.pages.map(page).join("")}</details>`
      : page(i);
  return `<aside class="docs-side"><nav aria-label="Documentation">${groups
    .map((g) => `<div class="docs-group"><p>${escapeHtml(g.heading)}</p>${g.items.map(item).join("")}</div>`)
    .join("")}</nav></aside>${keepSidebarScroll}`;
}

function toc(doc: RenderedDoc): string {
  if (doc.toc.length === 0) return "";
  return `<aside class="docs-toc"><p>On this page</p><ul>${doc.toc
    .map((t) => `<li class="depth-${t.depth}"><a href="#${t.id}">${escapeHtml(t.text)}</a></li>`)
    .join("")}</ul></aside>`;
}

function pager(page: DocPage): string {
  const i = pages.indexOf(page);
  const side = (p: DocPage | undefined, label: string, cls: string) =>
    p
      ? `<a class="${cls}" href="${href(p.slug)}"><small>${label}</small>${escapeHtml(fullTitle(p))}</a>`
      : "<span></span>";
  return `<nav class="docs-pager" aria-label="Pages">${side(pages[i - 1], "Previous", "prev")}${side(pages[i + 1], "Next", "next")}</nav>`;
}

const searchDialog = `<dialog class="docs-search" aria-label="Search the documentation">
  <div class="docs-search-field">${ICON_SEARCH}<input type="search" placeholder="Search the docs" autocomplete="off" spellcheck="false" /><kbd>Esc</kbd></div>
  <div class="docs-search-results" role="listbox"></div>
</dialog>`;

function shell(current: DocPage | undefined, main: string, aside = ""): string {
  return `${header(current)}
<div class="docs-layout${aside ? " has-toc" : ""}">
  ${sidebar(current)}
  <main class="docs-main">${main}</main>
  ${aside}
</div>
${searchDialog}`;
}

export function docPage(page: DocPage, doc: RenderedDoc): Html {
  const markdown = `${href(page.slug)}.md`;
  const main = `<div class="docs-title">
    <h1>${doc.titleHtml}</h1>
    <button type="button" class="docs-copy-page" data-src="${markdown}">${ICON_COPY}<span>Copy page</span></button>
  </div>
  <article class="docs-prose">${doc.html}</article>
  ${pager(page)}`;
  return {
    head: head(`${doc.title} · Kairos docs`, page.blurb, markdown),
    body: shell(page, main, toc(doc)),
  };
}

export function indexPage(lede: string): Html {
  const main = `<p class="docs-eyebrow">Documentation</p>
  <h1 class="docs-hero">Kairos documentation</h1>
  <p class="docs-lede">${escapeHtml(lede)}</p>
  ${groups
    .map(
      (g) => `<section class="docs-cards">
    <h2>${escapeHtml(g.heading)}</h2>
    <div>${groupPages(g)
      .map(
        (p) =>
          `<a class="docs-card" href="${href(p.slug)}"><b>${escapeHtml(fullTitle(p))}</b><span>${escapeHtml(p.blurb)}</span></a>`,
      )
      .join("")}</div>
  </section>`,
    )
    .join("")}`;
  return { head: head("Kairos documentation", lede), body: shell(undefined, main) };
}

export function fill(template: string, html: Html): string {
  return template.replace("<!--docs:head-->", () => html.head).replace("<!--docs:body-->", () => html.body);
}
