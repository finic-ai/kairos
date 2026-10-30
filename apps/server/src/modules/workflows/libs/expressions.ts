import { isCelError, isCelList, isCelMap, parse, run } from "@bufbuild/cel";
import { strings } from "@bufbuild/cel/ext";

/**
 * The expressions of a workflow: CEL for conditions, and `{{ … }}` templates for values.
 * CEL is not Turing-complete and reads only the variables the runner gives it
 * (internal/designs/workflows.md, section 6).
 */

export type Variables = Record<string, unknown>;

/** An expression that cannot be read or run. The same expression fails again: it is not tried again. */
export class ExpressionError extends Error {}

/** Null when the expression parses, else what is wrong with it. Used when a workflow is saved. */
export function parseExpression(expression: string): string | null {
  try {
    parse(expression);
    return null;
  } catch (cause) {
    return (cause as Error).message;
  }
}

/** A CEL value as plain JSON data: bigints become numbers, CEL maps and lists become objects and lists. */
export function toPlain(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (isCelMap(value)) return Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), toPlain(v)]));
  if (isCelList(value)) return [...value.values()].map(toPlain);
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === "object" && (value as object).constructor === Object)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]));
  return value;
}

/** Throws with the CEL message. */
export function evaluate(expression: string, vars: Variables): unknown {
  let result: unknown;
  try {
    result = run(expression, vars as Record<string, never>, { funcs: strings });
  } catch (cause) {
    throw new ExpressionError((cause as Error).message);
  }
  if (isCelError(result)) throw new ExpressionError(result.message);
  return toPlain(result);
}

/** Evaluate a `when` or `over` field, which must give true or false. */
export function evaluateCondition(expression: string, vars: Variables): boolean {
  const value = evaluate(expression, vars);
  if (typeof value !== "boolean")
    throw new ExpressionError(`"${expression}" gave ${JSON.stringify(value)}, not true or false`);
  return value;
}

const WHOLE = /^\{\{\s*([\s\S]*?)\s*\}\}$/;
const PART = /\{\{\s*([\s\S]*?)\s*\}\}/g;

const asText = (value: unknown): string =>
  value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);

/**
 * Templates in a value. A field that is only one template keeps the type of its expression,
 * so `"{{ event.entities }}"` is an object, not text. Templates inside text become text.
 */
export function resolveValue(value: unknown, vars: Variables): unknown {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole && !whole[1]!.includes("{{")) return evaluate(whole[1]!, vars);
    return value.replace(PART, (_all, expr: string) => asText(evaluate(expr, vars)));
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, vars));
  if (value && typeof value === "object" && (value as object).constructor === Object)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v, vars)]));
  return value;
}

/** "24h", "30m", "7d", "45s" as milliseconds. Null when it is not such a time. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(text.trim());
  if (!m) return null;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return Number(m[1]) * unit;
}
