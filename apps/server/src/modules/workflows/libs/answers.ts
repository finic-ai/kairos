import { answerPaths, type AnswerFinding } from "@kairos/core";
import type { WorkflowStepDef } from "../types";

const message = (f: AnswerFinding) =>
  f.kind === "delay_before_answer"
    ? `${f.path}: the delay "${f.step.name}" comes before the answer, and the caller cannot wait for it`
    : f.kind === "answer_in_loop"
      ? `${f.path}: an Answer step cannot be in a loop, which runs more than once`
      : `${f.path}: the run already gave its answer on this path`;

/**
 * The problems with the answers of a workflow. `waits`: a caller waits for the answer, so no
 * delay can come before it. `mustAnswer`: each path must answer, as a decision workflow's must.
 */
export function answerProblems(steps: WorkflowStepDef[], { waits = false, mustAnswer = false } = {}): string[] {
  const paths = answerPaths(steps);
  const problems = paths.findings.filter((f) => waits || f.kind !== "delay_before_answer").map(message);
  if (mustAnswer && paths.answered !== "yes")
    problems.push(
      `steps: ${paths.answered === "no" ? "the workflow never answers" : "on some paths the workflow does not answer"}: end each path with an Answer or a Return step`,
    );
  return problems;
}

/** Why a caller cannot wait for a run of these steps, or null when it can: a delay before the answer. */
export function waitProblem(steps: WorkflowStepDef[]): string | null {
  const delay = answerPaths(steps).findings.find((f) => f.kind === "delay_before_answer");
  return delay ? message(delay) : null;
}
