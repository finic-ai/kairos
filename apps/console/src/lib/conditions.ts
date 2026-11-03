/**
 * The condition builder's model, and the CEL it stands for. The server stores and runs only the
 * CEL. The builder writes it from rules, and reads back the CEL it writes, so a condition opens
 * in the builder again; other CEL stays an expression.
 */

export type Op =
  "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "starts" | "ends" | "in" | "inlist" | "exists" | "missing";

export interface Rule {
  kind: "rule";
  field: string;
  op: Op;
  /** As the person typed it: a number, true or false, a text, or for "in" values split by commas. */
  value: string;
}

export interface Group {
  kind: "group";
  join: "all" | "any";
  items: (Rule | Group)[];
}

export const OPS: { op: Op; label: string; takes: boolean }[] = [
  { op: "eq", label: "is", takes: true },
  { op: "ne", label: "is not", takes: true },
  { op: "gt", label: "is more than", takes: true },
  { op: "gte", label: "is at least", takes: true },
  { op: "lt", label: "is less than", takes: true },
  { op: "lte", label: "is at most", takes: true },
  { op: "contains", label: "contains", takes: true },
  { op: "starts", label: "starts with", takes: true },
  { op: "ends", label: "ends with", takes: true },
  { op: "in", label: "is one of", takes: true },
  { op: "inlist", label: "is in the list", takes: true },
  { op: "exists", label: "is set", takes: false },
  { op: "missing", label: "is not set", takes: false },
];

export const takesValue = (op: Op) => OPS.find((o) => o.op === op)?.takes ?? true;

export const emptyGroup = (join: Group["join"] = "all"): Group => ({ kind: "group", join, items: [] });
export const emptyRule = (field = ""): Rule => ({ kind: "rule", field, op: "eq", value: "" });

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
export const isPath = (text: string) => PATH.test(text);

/** A value as CEL: a number, true, false or null as it is; a text in quotes, which also keeps "123" a text. */
export function literal(raw: string): string {
  const text = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(text) || /^(true|false|null)$/.test(text)) return text;
  const quoted = /^"(.*)"$/s.exec(text) ?? /^'(.*)'$/s.exec(text);
  const inner = quoted ? quoted[1]! : text;
  return `'${inner.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function ruleCel(rule: Rule): string | null {
  if (!isPath(rule.field)) return null;
  const f = rule.field;
  if (rule.op === "exists") return `has(${f})`;
  if (rule.op === "missing") return `!has(${f})`;
  if (rule.value.trim() === "") return null;
  const v = literal(rule.value);
  switch (rule.op) {
    case "eq":
      return `${f} == ${v}`;
    case "ne":
      return `${f} != ${v}`;
    case "gt":
      return `${f} > ${v}`;
    case "gte":
      return `${f} >= ${v}`;
    case "lt":
      return `${f} < ${v}`;
    case "lte":
      return `${f} <= ${v}`;
    case "contains":
      return `${f}.contains(${v})`;
    case "starts":
      return `${f}.startsWith(${v})`;
    case "ends":
      return `${f}.endsWith(${v})`;
    case "inlist":
      return `inList(${f}, ${literal(rule.value.replace(/^["']|["']$/g, ""))})`;
    case "in": {
      const items = rule.value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return items.length ? `${f} in [${items.map(literal).join(", ")}]` : null;
    }
  }
}

/** The CEL of a group. Rules that are not complete yet are left out. Empty: no condition. */
export function toCel(group: Group, top = true): string {
  const parts = group.items
    .map((item) => (item.kind === "rule" ? ruleCel(item) : toCel(item, false)))
    .filter((p): p is string => !!p);
  if (parts.length === 0) return "";
  const joined = parts.join(group.join === "all" ? " && " : " || ");
  return !top && parts.length > 1 ? `(${joined})` : joined;
}

/** The rules that are not complete yet: the builder marks them, and they are not in the CEL. */
export const incomplete = (group: Group): number =>
  group.items.reduce((n, item) => n + (item.kind === "rule" ? (ruleCel(item) ? 0 : 1) : incomplete(item)), 0);

type Token = { t: "id" | "num" | "str" | "op" | "punct"; v: string };

function tokens(text: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(two)) {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("<>".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    if ("()[],.!".includes(c)) {
      out.push({ t: "punct", v: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\" && j + 1 < text.length) {
          s += text[j + 1];
          j += 2;
        } else s += text[j++];
      }
      if (j >= text.length) return null;
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(text.slice(i));
    if (num && (c !== "-" || out.length === 0 || out.at(-1)!.t !== "id")) {
      out.push({ t: "num", v: num[0] });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    return null;
  }
  return out;
}

const COMPARE: Record<string, Op> = { "==": "eq", "!=": "ne", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };
const METHOD: Record<string, Op> = { contains: "contains", startsWith: "starts", endsWith: "ends" };

/** A literal token as the builder shows it: a text that looks like a number keeps its quotes. */
const shown = (token: Token) =>
  token.t === "str" && /^(-?\d+(\.\d+)?|true|false|null)$/.test(token.v) ? `"${token.v}"` : token.v;

/** The rules that a CEL condition stands for, when the builder can show it; otherwise null. */
export function fromCel(text: string): Group | null {
  if (!text.trim()) return emptyGroup();
  const ts = tokens(text);
  if (!ts) return null;
  let i = 0;
  const peek = () => ts[i];
  const take = (v?: string) => {
    const token = ts[i];
    if (!token || (v !== undefined && token.v !== v)) throw new Error("unexpected");
    i++;
    return token;
  };
  const path = () => {
    let p = take().v;
    if (!/^[A-Za-z_]/.test(p)) throw new Error("path");
    while (peek()?.v === "." && ts[i + 1]?.t === "id" && ts[i + 2]?.v !== "(") {
      take(".");
      p += `.${take().v}`;
    }
    return p;
  };
  const value = () => {
    const token = take();
    if (token.t === "num" || token.t === "str" || (token.t === "id" && /^(true|false|null)$/.test(token.v)))
      return shown(token);
    throw new Error("value");
  };
  const rule = (): Rule => {
    if (peek()?.v === "!" && ts[i + 1]?.v === "has") {
      take("!");
      take("has");
      take("(");
      const field = path();
      take(")");
      return { kind: "rule", field, op: "missing", value: "" };
    }
    if (peek()?.v === "has" && ts[i + 1]?.v === "(") {
      take("has");
      take("(");
      const field = path();
      take(")");
      return { kind: "rule", field, op: "exists", value: "" };
    }
    if (peek()?.v === "inList" && ts[i + 1]?.v === "(") {
      take("inList");
      take("(");
      const field = path();
      take(",");
      const list = take();
      if (list.t !== "str") throw new Error("list");
      take(")");
      return { kind: "rule", field, op: "inlist", value: list.v };
    }
    const field = path();
    const next = peek();
    if (next?.t === "op" && COMPARE[next.v]) {
      take();
      return { kind: "rule", field, op: COMPARE[next.v]!, value: value() };
    }
    if (next?.v === "." && METHOD[ts[i + 1]?.v ?? ""]) {
      take(".");
      const op = METHOD[take().v]!;
      take("(");
      const v = value();
      take(")");
      return { kind: "rule", field, op, value: v };
    }
    if (next?.t === "id" && next.v === "in") {
      take();
      take("[");
      const items: string[] = [];
      while (peek()?.v !== "]") {
        items.push(value());
        if (peek()?.v === ",") take(",");
      }
      take("]");
      return { kind: "rule", field, op: "in", value: items.join(", ") };
    }
    throw new Error("rule");
  };
  const group = (): Group => {
    const items: (Rule | Group)[] = [];
    let join: Group["join"] | null = null;
    for (;;) {
      if (peek()?.v === "(") {
        take("(");
        items.push(group());
        take(")");
      } else items.push(rule());
      const next = peek();
      if (next?.t !== "op" || (next.v !== "&&" && next.v !== "||")) break;
      const j = next.v === "&&" ? "all" : "any";
      // One group joins its items one way; a mix needs parentheses, which the builder writes.
      if (join && join !== j) throw new Error("mixed");
      join = j;
      take();
    }
    return { kind: "group", join: join ?? "all", items };
  };
  try {
    const result = group();
    return i === ts.length ? result : null;
  } catch {
    return null;
  }
}
