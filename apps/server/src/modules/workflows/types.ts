/**
 * A workflow definition, as it is saved: one trigger and a list of steps. It is data, and it
 * is versioned like an action (internal/designs/workflows.md, section 4). The step fields
 * beyond `id`, `name` and `type` depend on the type and are checked by `validateWorkflow`.
 */
export interface WorkflowStepDef {
  id: string;
  name: string;
  type: string;
  [field: string]: unknown;
}

export interface WorkflowTriggerDef {
  type: string;
  [field: string]: unknown;
}

export interface WorkflowDefinitionDef {
  name: string;
  displayName?: string;
  enabled?: boolean;
  trigger: WorkflowTriggerDef;
  steps: WorkflowStepDef[];
}

/** The types of a manual trigger's inputs. An `entity` input is the id of an entity of its `entity` type. */
export const INPUT_TYPES = ["text", "number", "boolean", "entity", "list", "object"] as const;
export type WorkflowInputType = (typeof INPUT_TYPES)[number];

/** One input of a manual trigger. The steps read it as `trigger.<name>`. */
export interface WorkflowInputDef {
  name: string;
  type: WorkflowInputType;
  required?: boolean;
  label?: string;
  description?: string;
  /** For an `entity` input: the entity type, such as "user". */
  entity?: string;
  default?: unknown;
}

export const MAX_INPUTS = 30;

/** A run that the caller waits for: by default and at most, in seconds. */
export const WAIT_SECONDS = 10;
export const MAX_WAIT_SECONDS = 30;

/** The outcomes a decision workflow can answer with, as an action's decision has. */
export const DECISION_OUTCOMES = ["approve", "step_up", "review", "block"] as const;
/** A decision workflow's time until its answer, apart from the model: by default, in seconds. */
export const DECISION_WAIT_SECONDS = 5;

export const MAX_STEPS = 50;
export const MAX_DEPTH = 3;
export const MAX_LOOP = 1000;
/** A run lasts at most this long, delays included. */
export const MAX_RUN_DAYS = 30;
/** A workflow has at most this many runs that hold a place: running, waiting, or queued with a job. */
export const MAX_OPEN_RUNS = 20;

/** The job kind that runs one segment of a workflow run. */
export const WORKFLOW_RUN_KIND = "workflow.run";
