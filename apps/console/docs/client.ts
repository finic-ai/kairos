import type { SearchEntry } from "./render";

const $ = <T extends Element>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector);
const $$ = <T extends Element>(selector: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(selector));

const ICON_COPY = `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9.5" height="9.5" rx="2"/><path d="M4 13V5.5A1.5 1.5 0 0 1 5.5 4H13"/></svg>`;
const ICON_DONE = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>`;

function flash(button: HTMLElement, idle: string, done: string) {
  button.innerHTML = done;
  setTimeout(() => (button.innerHTML = idle), 1600);
}

for (const button of $$<HTMLButtonElement>(".docs-copy")) {
  button.innerHTML = ICON_COPY;
  button.addEventListener("click", async () => {
    const code = button.parentElement?.querySelector("pre")?.innerText ?? "";
    await navigator.clipboard.writeText(code.replace(/\n$/, ""));
    flash(button, ICON_COPY, ICON_DONE);
  });
}

const copyPage = $<HTMLButtonElement>(".docs-copy-page");
copyPage?.addEventListener("click", async () => {
  const idle = copyPage.innerHTML;
  const markdown = fetch(copyPage.dataset.src!).then((r) => r.text());
  // Safari keeps the click's permission to write only for a write that starts during the click.
  await navigator.clipboard.write([new ClipboardItem({ "text/plain": markdown })]);
  flash(copyPage, idle, `${ICON_DONE}<span>Copied</span>`);
});

const menu = $<HTMLButtonElement>(".docs-menu");
menu?.addEventListener("click", () => {
  const open = document.body.classList.toggle("docs-nav-open");
  menu.setAttribute("aria-expanded", String(open));
});

const tocLinks = $$<HTMLAnchorElement>(".docs-toc a");
if (tocLinks.length) {
  const byId = new Map(tocLinks.map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const a of tocLinks) a.classList.toggle("active", a === byId.get(entry.target.id));
      }
    },
    { rootMargin: "-72px 0px -70% 0px" },
  );
  for (const id of byId.keys()) {
    const heading = document.getElementById(id);
    if (heading) observer.observe(heading);
  }
}

const dialog = $<HTMLDialogElement>(".docs-search")!;
const input = $<HTMLInputElement>("input", dialog)!;
const list = $<HTMLDivElement>(".docs-search-results", dialog)!;
let entries: Promise<SearchEntry[]> | undefined;
let results: SearchEntry[] = [];
let active = 0;

function rank(all: SearchEntry[], query: string): SearchEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: { entry: SearchEntry; score: number }[] = [];
  for (const entry of all) {
    const title = entry.title.toLowerCase();
    const page = entry.page.toLowerCase();
    const text = entry.text.toLowerCase();
    if (!words.every((w) => title.includes(w) || page.includes(w) || text.includes(w))) continue;
    let score = title.startsWith(words[0]!) ? 3 : 0;
    for (const w of words)
      score += (title.includes(w) ? 4 : 0) + (page.includes(w) ? 1 : 0) + (text.includes(w) ? 1 : 0);
    scored.push({ entry, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map((s) => s.entry);
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const target = (e: SearchEntry) => `/docs/${e.slug}${e.id ? `#${e.id}` : ""}`;

function draw() {
  if (!input.value.trim()) {
    list.innerHTML = `<p class="docs-search-note">Search the guides and the reference.</p>`;
    return;
  }
  if (results.length === 0) {
    list.innerHTML = `<p class="docs-search-note">No results for “${escape(input.value)}”.</p>`;
    return;
  }
  list.innerHTML = results
    .map(
      (e, i) =>
        `<a href="${target(e)}" role="option"${i === active ? ` class="active" aria-selected="true"` : ""}>
          <b>${escape(e.title)}</b><small>${escape(e.page)}</small>${e.text ? `<span>${escape(e.text)}</span>` : ""}
        </a>`,
    )
    .join("");
  $(".active", list)?.scrollIntoView({ block: "nearest" });
}

async function search() {
  results = rank(await entries!, input.value);
  active = 0;
  draw();
}

function openSearch() {
  entries ??= fetch("/docs/search.json").then((r) => r.json() as Promise<SearchEntry[]>);
  input.value = "";
  results = [];
  draw();
  dialog.showModal();
}

$(".docs-search-open")?.addEventListener("click", openSearch);
input.addEventListener("input", search);
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});
list.addEventListener("click", (e) => {
  if ((e.target as Element).closest("a")) dialog.close();
});
input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    active = Math.max(0, Math.min(results.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
    draw();
  } else if (e.key === "Enter" && results[active]) {
    e.preventDefault();
    dialog.close();
    location.href = target(results[active]);
  }
});
document.addEventListener("keydown", (e) => {
  const typing = (e.target as Element).closest("input, textarea, [contenteditable]");
  if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing)) {
    e.preventDefault();
    if (dialog.open) dialog.close();
    else openSearch();
  }
});
