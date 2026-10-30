/** A workflow step, as far as its answer is concerned. */
export interface AnswerStep {
  id: string;
  name: string;
  type: string;
  [field: string]: unknown;
}

export type AnswerFinding =
  /** Reported always: it is a problem only when a caller waits for the answer. */
  | { kind: "delay_before_answer"; step: AnswerStep; path: string }
  | { kind: "answer_in_loop"; step: AnswerStep; path: string }
  | { kind: "second_answer"; step: AnswerStep; path: string };

export interface AnswerPaths {
  findings: AnswerFinding[];
  /** Whether the paths to the end of the steps have answered: none of them, some, or all. */
  answered: "no" | "some" | "yes";
  /** The ids of the steps that write, and can run before the answer. */
  writesBefore: string[];
}

type Reach = AnswerPaths["answered"];
const merge = (a: Reach, b: Reach): Reach => (a === b ? a : "some");
const WRITES = new Set(["record.create", "record.update", "decide", "case.create", "case.resolve"]);

/**
 * Walk the paths of a workflow's steps, as a run can take them, and find what concerns its
 * answer. An Answer step gives the answer and the run goes on; a Return ends its path, and is
 * its answer when none came before. A loop can run no time at all.
 */
export function answerPaths(steps: AnswerStep[]): AnswerPaths {
  const out: AnswerPaths = { findings: [], answered: "no", writesBefore: [] };
  const walk = (list: AnswerStep[], state: Reach, inLoop: boolean, where: string) => {
    for (const step of list) {
      const path = `${where}.${step.id}`;
      const inner = (branch: string) => (Array.isArray(step[branch]) ? (step[branch] as AnswerStep[]) : []);
      if (state !== "yes" && WRITES.has(step.type)) out.writesBefore.push(step.id);
      if (step.type === "delay") {
        if (state !== "yes") out.findings.push({ kind: "delay_before_answer", step, path });
      } else if (step.type === "answer") {
        if (inLoop) out.findings.push({ kind: "answer_in_loop", step, path });
        else if (state !== "no") out.findings.push({ kind: "second_answer", step, path });
        state = "yes";
      } else if (step.type === "return") {
        return { state: "yes" as Reach, ended: true };
      } else if (step.type === "condition") {
        const yes = walk(inner("then"), state, inLoop, `${path}.then`);
        const no = walk(inner("else"), state, inLoop, `${path}.else`);
        if (yes.ended && no.ended) return { state: "yes" as Reach, ended: true };
        state = yes.ended ? no.state : no.ended ? yes.state : merge(yes.state, no.state);
      } else if (step.type === "loop") {
        state = merge(state, walk(inner("steps"), state, true, `${path}.steps`).state);
      }
    }
    return { state, ended: false };
  };
  out.answered = walk(steps, "no", false, "steps").state;
  return out;
}
