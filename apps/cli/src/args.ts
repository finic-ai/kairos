import { readFileSync } from "node:fs";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** A failure to report in one line, without a stack trace. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export function parse<const O extends ParseArgsOptionsConfig>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (cause) {
    throw new CliError((cause as Error).message);
  }
}

/** `user=u_42` → `{ user: "u_42" }`. Ids stay text. */
export function pairs(values: string[] | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values ?? []) {
    const at = value.indexOf("=");
    if (at <= 0) throw new CliError(`${what} "${value}" must be name=value`);
    out[value.slice(0, at)] = value.slice(at + 1);
  }
  return out;
}

/** A value typed on the command line: a number, true, false, null or JSON when it is one, otherwise text. */
export function coerce(value: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(value) && !/^-?0\d/.test(value)) return Number(value);
  if (value === "true" || value === "false" || value === "null") return JSON.parse(value);
  if (/^[[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function props(values: string[] | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(pairs(values, "Property")).map(([key, value]) => [key, coerce(value)]));
}

/** JSON from `--data`: inline, or `@path` to read a file. */
export function json(value: string | undefined, what = "--data"): unknown {
  if (value === undefined) return undefined;
  const text = value.startsWith("@") ? readText(value.slice(1)) : value;
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`${what} is not valid JSON`);
  }
}

export function object(value: string | undefined, what = "--data"): Record<string, unknown> {
  const parsed = json(value, what);
  if (parsed === undefined) return {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new CliError(`${what} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

export function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new CliError(`Cannot read ${path}`);
  }
}

export function timestamp(value: string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new CliError(`"${value}" is not a time. Use ISO 8601: 2026-10-06T13:58:00Z`);
  return date.toISOString();
}

export function entityRef(value: string): { type: string; id: string } {
  const at = value.indexOf(":");
  if (at <= 0 || at === value.length - 1) throw new CliError(`"${value}" must be type:id, for example user:u_42`);
  return { type: value.slice(0, at), id: value.slice(at + 1) };
}

export function integer(value: string | undefined, what: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new CliError(`${what} must be a whole number`);
  return number;
}
