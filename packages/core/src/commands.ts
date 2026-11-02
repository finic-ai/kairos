import { ENTITY_COLORS, ENTITY_ICONS, type EntityColor, type EntityIcon } from "./entities";

/** Where a command's button is shown. Omit it and the button is on both pages. */
export const COMMAND_VISIBILITY = ["all", "case", "entity"] as const;
export type CommandVisibility = (typeof COMMAND_VISIBILITY)[number];

export const COMMAND_INPUT_TYPES = ["text", "number", "boolean", "choice"] as const;
export type CommandInputType = (typeof COMMAND_INPUT_TYPES)[number];

export const MAX_COMMANDS = 8;
export const MAX_COMMAND_INPUTS = 6;
export const MAX_COMMAND_OPTIONS = 20;
const MAX_LABEL = 40;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 500;
const MAX_INPUT_LABEL = 80;
const MAX_OPTION = 80;
const MAX_TEXT = 2000;

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A field the reviewer fills before Kairos sends the webhook. */
export interface CommandInput {
  name: string;
  label: string;
  type: CommandInputType;
  required?: boolean;
  /** For `choice`: the values the reviewer can pick. */
  options?: string[];
}

/**
 * A button on an entity type. A click sends `command.issued`. The customer's system does the work.
 * This is not an action: an action is a decision type.
 */
export interface EntityCommand {
  /** The name in the definition. */
  name: string;
  /** The key in the webhook. The console fills it from the name. A person can change it. */
  key: string;
  /** What the command asks the customer's system to do. */
  description?: string;
  /** The text on the button. */
  label: string;
  color: EntityColor;
  /** Omit it and the button is text only. */
  icon?: EntityIcon;
  visibility?: CommandVisibility;
  inputs?: CommandInput[];
}

/** What one webhook answer means. No status means the request did not arrive. */
export type CommandAnswer = "acted" | "received" | "not_delivered";

export function commandAnswer(status: number | undefined): CommandAnswer {
  if (status === 200) return "acted";
  if (status !== undefined && status >= 200 && status < 300) return "received";
  return "not_delivered";
}

/** The command as the console shows it, from every endpoint that was sent the click. */
export type CommandState = CommandAnswer | "sending" | "not_sent";

export function commandState(deliveries: { status: string; responseStatus: number | null }[]): CommandState {
  if (deliveries.some((d) => d.responseStatus === 200)) return "acted";
  if (deliveries.some((d) => commandAnswer(d.responseStatus ?? undefined) === "received")) return "received";
  if (deliveries.some((d) => d.status === "pending")) return "sending";
  if (deliveries.length === 0) return "not_sent";
  return "not_delivered";
}

/** Problems in a command list. Empty when it can be saved. */
export function validateCommands(commands: EntityCommand[] | undefined): string[] {
  if (commands === undefined) return [];
  if (!Array.isArray(commands)) return ["commands must be a list"];
  const problems: string[] = [];
  if (commands.length > MAX_COMMANDS) problems.push(`commands: at most ${MAX_COMMANDS}`);
  const keys = new Set<string>();
  commands.forEach((command, i) => {
    const at = `commands[${i}]`;
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      problems.push(`${at} must be a command`);
      return;
    }
    if (!NAME.test(command.key ?? "")) problems.push(`${at}.key must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$`);
    else if (keys.has(command.key)) problems.push(`${at}.key "${command.key}" is already used`);
    else keys.add(command.key);
    if (typeof command.name !== "string" || !command.name.trim() || command.name.length > MAX_NAME)
      problems.push(`${at}.name must be text, up to ${MAX_NAME} characters`);
    if (
      command.description !== undefined &&
      (typeof command.description !== "string" ||
        !command.description.trim() ||
        command.description.length > MAX_DESCRIPTION)
    )
      problems.push(`${at}.description must be text, up to ${MAX_DESCRIPTION} characters`);
    if (typeof command.label !== "string" || !command.label.trim() || command.label.length > MAX_LABEL)
      problems.push(`${at}.label must be text, up to ${MAX_LABEL} characters`);
    if (!ENTITY_COLORS.includes(command.color)) problems.push(`${at}.color must be one of ${ENTITY_COLORS.join(", ")}`);
    if (command.icon !== undefined && !ENTITY_ICONS.includes(command.icon))
      problems.push(`${at}.icon must be one of ${ENTITY_ICONS.join(", ")}`);
    if (command.visibility !== undefined && !COMMAND_VISIBILITY.includes(command.visibility))
      problems.push(`${at}.visibility must be all, case or entity`);
    problems.push(...validateInputs(command.inputs, at));
  });
  return problems;
}

function validateInputs(inputs: CommandInput[] | undefined, at: string): string[] {
  if (inputs === undefined) return [];
  if (!Array.isArray(inputs)) return [`${at}.inputs must be a list`];
  const problems: string[] = [];
  if (inputs.length > MAX_COMMAND_INPUTS) problems.push(`${at}.inputs: at most ${MAX_COMMAND_INPUTS}`);
  const names = new Set<string>();
  inputs.forEach((input, i) => {
    const here = `${at}.inputs[${i}]`;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      problems.push(`${here} must be a field`);
      return;
    }
    if (!NAME.test(input.name ?? "")) problems.push(`${here}.name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$`);
    else if (names.has(input.name)) problems.push(`${here}.name "${input.name}" is already used`);
    else names.add(input.name);
    if (typeof input.label !== "string" || !input.label.trim() || input.label.length > MAX_INPUT_LABEL)
      problems.push(`${here}.label must be text, up to ${MAX_INPUT_LABEL} characters`);
    if (!COMMAND_INPUT_TYPES.includes(input.type))
      problems.push(`${here}.type must be one of ${COMMAND_INPUT_TYPES.join(", ")}`);
    if (input.required !== undefined && typeof input.required !== "boolean")
      problems.push(`${here}.required must be true or false`);
    if (input.type === "choice") {
      const options = input.options;
      if (
        !Array.isArray(options) ||
        options.length < 2 ||
        options.length > MAX_COMMAND_OPTIONS ||
        new Set(options).size !== options.length ||
        options.some((option) => typeof option !== "string" || !option.trim() || option.length > MAX_OPTION)
      )
        problems.push(`${here}.options must be ${2} to ${MAX_COMMAND_OPTIONS} different texts`);
    } else if (input.options !== undefined) problems.push(`${here}.options is only for a choice`);
  });
  return problems;
}

/**
 * The values to send, in the order of the definition. A problem means nothing is sent.
 * Unknown keys are refused. An optional field that was left out is left out.
 */
export function readCommandInputs(
  command: EntityCommand,
  raw: Record<string, unknown> | undefined,
): { inputs: Record<string, unknown>; problems: string[] } {
  const given = raw ?? {};
  const known = new Set((command.inputs ?? []).map((input) => input.name));
  const problems: string[] = [];
  for (const key of Object.keys(given))
    if (!known.has(key)) problems.push(`inputs.${key} is not a field of this command`);
  const inputs: Record<string, unknown> = {};
  for (const field of command.inputs ?? []) {
    const value = given[field.name];
    if (value === undefined) {
      if (field.required) problems.push(`inputs.${field.name} is required`);
      continue;
    }
    const problem = inputProblem(field, value);
    if (problem) problems.push(problem);
    else inputs[field.name] = value;
  }
  return { inputs, problems };
}

function inputProblem(field: CommandInput, value: unknown): string | undefined {
  const at = `inputs.${field.name}`;
  if (field.type === "text") {
    if (typeof value !== "string" || value.length > MAX_TEXT) return `${at} must be text, up to ${MAX_TEXT} characters`;
    if (field.required && !value.trim()) return `${at} is required`;
    return;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${at} must be a number`;
    return;
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") return `${at} must be true or false`;
    return;
  }
  if (typeof value !== "string" || !field.options?.includes(value)) return `${at} must be one of the choices`;
}
