import type { WorkflowStepDef } from "../types";
import { evaluate, resolveValue, type Variables } from "./expressions";

const STRUCTURE = new Set(["id", "name", "type", "then", "else", "steps", "retry", "on_fail"]);
const EXPRESSIONS = new Set(["when", "over"]);
const MAX_INPUT_BYTES = 32 * 1024;
const REFERENCE = /\b(?:steps\.[A-Za-z_]\w*\.output|trigger|event|item|index)(?:\.[A-Za-z_]\w*)*/g;

/** The value of each field that an expression reads, as the run had it. A field that is not there is left out. */
export function readsOf(expression: string, vars: Variables): Record<string, unknown> {
  const reads: Record<string, unknown> = {};
  for (const [path] of expression.matchAll(REFERENCE)) {
    if (path in reads) continue;
    try {
      reads[path] = evaluate(path, vars);
    } catch {
      // Not there in this run.
    }
  }
  return reads;
}

/**
 * A step's fields with their templates filled in, for the run log. Secrets are not in `vars`, so
 * a field that reads one keeps its template and its value is never logged.
 */
export function stepInput(step: WorkflowStepDef, vars: Variables): Record<string, unknown> | undefined {
  const input: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(step)) {
    if (STRUCTURE.has(field)) continue;
    if (EXPRESSIONS.has(field) && typeof value === "string") {
      input[field] = value;
      input.reads = readsOf(value, vars);
      continue;
    }
    try {
      input[field] = resolveValue(value, vars);
    } catch {
      input[field] = value;
    }
  }
  // Header and query values hold tokens, and the run log is not encrypted.
  if (step.type === "http")
    for (const field of ["headers", "query"]) {
      const values = input[field];
      if (values && typeof values === "object" && !Array.isArray(values))
        input[field] = Object.fromEntries(Object.keys(values).map((k) => [k, "…"]));
    }
  if (Object.keys(input).length === 0) return undefined;
  const bytes = Buffer.byteLength(JSON.stringify(input));
  return bytes > MAX_INPUT_BYTES ? { truncated: true, bytes } : input;
}
