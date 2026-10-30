import { INPUT_TYPES, MAX_INPUTS, type WorkflowInputDef } from "../types";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Why a value is not of an input's type, or null when it is. */
function typeProblem(input: WorkflowInputDef, value: unknown): string | null {
  switch (input.type) {
    case "text":
      return typeof value === "string" ? null : "must be text";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : "must be a number";
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "entity":
      return typeof value === "string" && value.length > 0 && value.length <= 256
        ? null
        : `must be the id of ${input.entity ? `a ${input.entity}` : "an entity"}`;
    case "list":
      return Array.isArray(value) ? null : "must be a list";
    case "object":
      return isObject(value) ? null : "must be an object";
    default:
      return "has an unknown type";
  }
}

/** The problems with a manual trigger's `inputs`, as `validateWorkflow` gives them. */
export function inputsProblems(inputs: unknown): string[] {
  if (inputs === undefined) return [];
  if (!Array.isArray(inputs)) return ["trigger.inputs: must be a list of inputs"];
  const problems: string[] = [];
  if (inputs.length > MAX_INPUTS) problems.push(`trigger.inputs: at most ${MAX_INPUTS} inputs`);
  const names = new Set<string>();
  for (const [i, raw] of inputs.entries()) {
    const at = `trigger.inputs.${isObject(raw) && typeof raw.name === "string" && raw.name ? raw.name : i}`;
    if (!isObject(raw)) {
      problems.push(`${at}: an input is an object`);
      continue;
    }
    const input = raw as unknown as WorkflowInputDef;
    if (typeof input.name !== "string" || !NAME.test(input.name))
      problems.push(`${at}.name: letters, digits and _, starting with a letter`);
    else if (names.has(input.name)) problems.push(`${at}.name: another input has this name`);
    else names.add(input.name);
    if (!INPUT_TYPES.includes(input.type)) {
      problems.push(`${at}.type: ${INPUT_TYPES.join(", ")}`);
      continue;
    }
    if (input.required !== undefined && typeof input.required !== "boolean")
      problems.push(`${at}.required: true or false`);
    for (const field of ["label", "description"] as const)
      if (input[field] !== undefined && typeof input[field] !== "string") problems.push(`${at}.${field}: text`);
    if (
      input.type === "entity" &&
      input.entity !== undefined &&
      (typeof input.entity !== "string" || !NAME.test(input.entity))
    )
      problems.push(`${at}.entity: an entity type such as "user"`);
    if (input.default !== undefined) {
      const problem = typeProblem(input, input.default);
      if (problem) problems.push(`${at}.default: ${problem}`);
    }
  }
  return problems;
}

/**
 * Check a run's input against the trigger's inputs, and add the defaults. Inputs that the
 * trigger does not name are kept: the steps can read them too.
 */
export function checkInputs(
  inputs: WorkflowInputDef[] | undefined,
  given: Record<string, unknown>,
): { values: Record<string, unknown>; problems: string[] } {
  const values = { ...given };
  const problems: string[] = [];
  for (const input of inputs ?? []) {
    const value = values[input.name];
    if (value === undefined || value === null || value === "") {
      if (input.default !== undefined) values[input.name] = input.default;
      else if (input.required) problems.push(`input.${input.name}: is required`);
      else delete values[input.name];
      continue;
    }
    const problem = typeProblem(input, value);
    if (problem) problems.push(`input.${input.name}: ${problem}`);
  }
  return { values, problems };
}
