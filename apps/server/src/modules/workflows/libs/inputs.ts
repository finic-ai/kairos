import { checkInputs, inputTypeProblem as typeProblem } from "@kairos/core";
import { INPUT_TYPES, MAX_INPUTS, type WorkflowInputDef } from "../types";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

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

export { checkInputs };
