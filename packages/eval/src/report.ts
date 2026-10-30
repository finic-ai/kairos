import type { Decision } from "@kairos/core";
import { KINDS, type Kind } from "./generate";

export const CASES_FILE = "v1.jsonl";

export interface Row {
  id: string;
  kind: Kind;
  label: 0 | 1;
  decision: Decision;
  typologyOk: boolean;
  factsRight: number;
  factsScored: number;
  tokens: number;
}

export interface KindSummary {
  n: number;
  mean_probability: number;
  held: number;
  step_up: number;
  actioned: number;
  typology_correct: number;
}

export interface Summary {
  cases: string;
  action: string;
  catch_rate: number;
  false_action_rate: number;
  auc: number;
  reason_fact_accuracy: number;
  mean_tokens: number;
  kinds: Record<string, KindSummary>;
}

export function summarise(rows: Row[]): Summary {
  const positives = rows.filter((r) => r.label === 1);
  const negatives = rows.filter((r) => r.label === 0);
  const actioned = (r: Row) => r.decision.decision !== "approve";
  let wins = 0;
  for (const p of positives)
    for (const n of negatives)
      wins +=
        p.decision.probability > n.decision.probability
          ? 1
          : p.decision.probability === n.decision.probability
            ? 0.5
            : 0;

  const kinds: Record<string, KindSummary> = {};
  for (const kind of KINDS) {
    const k = rows.filter((r) => r.kind === kind);
    kinds[kind] = {
      n: k.length,
      mean_probability: round(k.reduce((a, r) => a + r.decision.probability, 0) / k.length),
      held: k.filter((r) => r.decision.decision === "review" || r.decision.decision === "block").length,
      step_up: k.filter((r) => r.decision.decision === "step_up").length,
      actioned: k.filter(actioned).length,
      typology_correct: k.filter((r) => r.typologyOk).length,
    };
  }
  return {
    cases: CASES_FILE,
    action: rows[0]!.decision.action,
    catch_rate: round(positives.filter(actioned).length / positives.length),
    false_action_rate: round(negatives.filter(actioned).length / negatives.length),
    auc: round(wins / (positives.length * negatives.length)),
    reason_fact_accuracy: round(
      rows.reduce((a, r) => a + r.factsRight, 0) / rows.reduce((a, r) => a + r.factsScored, 0),
    ),
    mean_tokens: Math.round(rows.reduce((a, r) => a + r.tokens, 0) / rows.length),
    kinds,
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export function print(summary: Summary, accepted: Summary | null) {
  const delta = (now: number, before: number | undefined) =>
    before === undefined || now === before ? "" : ` (${now > before ? "+" : ""}${round(now - before)})`;
  console.log(`\ncases ${summary.cases} · action ${summary.action}\n`);
  console.log("kind                 n  mean p  held  step-up  actioned  typology");
  for (const [kind, k] of Object.entries(summary.kinds)) {
    const a = accepted?.kinds[kind];
    console.log(
      `${kind.padEnd(20)} ${String(k.n).padStart(2)}  ${k.mean_probability.toFixed(2).padStart(6)}  ${String(k.held).padStart(4)}  ${String(k.step_up).padStart(7)}  ` +
        `${(String(k.actioned) + delta(k.actioned, a?.actioned)).padStart(8)}  ${String(k.typology_correct).padStart(8)}`,
    );
  }
  console.log(
    `\ncatch rate (positives not approved)        ${summary.catch_rate}${delta(summary.catch_rate, accepted?.catch_rate)}`,
  );
  console.log(
    `false-action rate (negatives not approved) ${summary.false_action_rate}${delta(summary.false_action_rate, accepted?.false_action_rate)}`,
  );
  console.log(`AUC of hold probability                    ${summary.auc}${delta(summary.auc, accepted?.auc)}`);
  console.log(
    `reason codes that match known facts        ${summary.reason_fact_accuracy}${delta(summary.reason_fact_accuracy, accepted?.reason_fact_accuracy)}`,
  );
  console.log(`mean input tokens                          ${summary.mean_tokens}`);
}
