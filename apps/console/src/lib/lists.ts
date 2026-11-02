import type { ListItem, ListMatch, ListSummary } from "../types/interfaces";
import { slug } from "./format";

export const MATCH_LABEL: Record<ListMatch, { label: string; note: string }> = {
  exact: { label: "Is the item", note: "For ids, emails and domains." },
  prefix: { label: "Starts with", note: "For BINs and phone codes." },
  suffix: { label: "Ends with", note: "For domains and their subdomains." },
  contains: { label: "Contains", note: "Anywhere in the value." },
  word: {
    label: "Contains as a word",
    note: "“card” is in “gift card”, not in “cardholder”.",
  },
};

export const MATCHES = Object.keys(MATCH_LABEL) as ListMatch[];

export const matchText = (m: { match: ListMatch; case_sensitive: boolean }) =>
  `${MATCH_LABEL[m.match].label}${m.case_sensitive ? ", case sensitive" : ""}`;

/** The match and case of an item: its own, or the list's. */
export const matchOf = (list: Pick<ListSummary, "match" | "case_sensitive">, item: ListItem) => ({
  match: item.match ?? list.match,
  case_sensitive: item.case_sensitive ?? list.case_sensitive,
  own: item.match !== undefined || item.case_sensitive !== undefined,
});

/** A list's slug made from its name: lower case and _, starting with a letter. */
export const listSlugFromName = (name: string) => {
  const base = slug(name).replace(/^_+/, "");
  return !base ? "" : /^[a-z]/.test(base) ? base : `list_${base}`;
};

/**
 * The items in a pasted text: one for each line, or split at commas too. A cell in quotes can
 * hold a comma, and "" in it is one quote.
 */
export function itemsFromText(text: string, split: "lines" | "commas"): string[] {
  const cells: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (split === "lines") {
      cells.push(line.trim());
      continue;
    }
    for (const cell of line.match(/("(?:[^"]|"")*"|[^,]*)(,|$)/g) ?? []) {
      const raw = cell.replace(/,$/, "").trim();
      cells.push(/^".*"$/s.test(raw) ? raw.slice(1, -1).replaceAll('""', '"').trim() : raw);
    }
  }
  return [...new Set(cells.filter(Boolean))];
}
