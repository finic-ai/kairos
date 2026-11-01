import { useMemo, useState } from "react";
import { valueText } from "../../lib/format";
import { traceOf } from "../../lib/trace";
import type { ModelScore, Outcome, PolicyRule, WorkflowRun, WorkflowStep } from "../../types/interfaces";
import { Chips } from "../ui/Chips";
import { Pill } from "./Outcome";
import { ANSWERS, modelOf, type Ran } from "./WorkflowTrace";

const MODEL_STEPS = new Set(["assess", "ask", "score"]);

type Answer = { value?: unknown; values?: unknown[]; level?: string; probability?: number; probabilities?: unknown };
interface Row {
  name: string;
  desc: string;
  p: number | null;
  on: boolean;
  rules: string[];
}

/** What the decision's own model answer and its action say, for a run that did not log its model's answer. */
export interface DecisionFindings {
  action: string;
  signals: [string, number][];
  descriptions?: Record<string, string>;
  threshold: number;
  policy?: PolicyRule[];
}

function rowsOf(item: Ran, decision: DecisionFindings): Row[] {
  const entry = item.entries[0]!;
  const out = (entry.output ?? {}) as Record<string, unknown>;
  if (item.step.type === "ask") {
    const questions = (item.step.questions ?? {}) as Record<string, { type?: string; question?: string }>;
    return Object.entries(questions).map(([key, q]) => {
      const a = out[key] as Answer | undefined;
      const chosen = a?.level ?? (a?.values ? a.values.join(", ") : a?.value);
      const probabilities = (a?.probabilities ?? {}) as Record<string, number>;
      const p =
        typeof a?.probability === "number"
          ? a.probability
          : typeof chosen === "string" && typeof probabilities[chosen] === "number"
            ? probabilities[chosen]!
            : null;
      const yesNo = q.type === "yes_no";
      return {
        name: key,
        desc: `${q.question ?? ""}${yesNo || chosen === undefined ? "" : ` Answer: ${valueText(chosen)}`}`,
        p,
        on: yesNo ? a?.value === true : chosen !== undefined,
        rules: [],
      };
    });
  }
  if (item.step.type !== "assess") return [];
  const sameAction = typeof out.action === "string" && out.action.split("@")[0] === decision.action.split("@")[0];
  const logged = (entry.read as { answers?: { reasons?: { probabilities?: Record<string, number> } } } | undefined)
    ?.answers?.reasons?.probabilities;
  const probabilities: [string, number][] | null = logged
    ? Object.entries(logged)
    : out.action === decision.action
      ? decision.signals
      : null;
  const threshold = sameAction ? decision.threshold : 0.5;
  const fired = Array.isArray(out.rules) ? out.rules.map(String) : [];
  const rulesOf = (code: string) =>
    sameAction
      ? (decision.policy ?? []).filter((r) => fired.includes(r.id) && r.allOf.includes(code)).map((r) => r.id)
      : [];
  const desc = (code: string) => (sameAction ? (decision.descriptions?.[code] ?? "") : "");
  if (!probabilities) {
    const reasons = Array.isArray(out.reasons) ? out.reasons.map(String) : [];
    return reasons.map((code) => ({ name: code, desc: desc(code), p: null, on: true, rules: rulesOf(code) }));
  }
  return [...probabilities]
    .sort((a, b) => b[1] - a[1])
    .map(([code, p]) => ({ name: code, desc: desc(code), p, on: p >= threshold, rules: rulesOf(code) }));
}

function Signal({ row }: { row: Row }) {
  return (
    <div className={`signal ${row.on ? "on" : ""}`}>
      <span className="dot" />
      <div>
        <div className="name">{row.name}</div>
        {row.desc && <div className="desc">{row.desc}</div>}
        {row.rules.map((r) => (
          <span key={r} className="signal-rule">
            → {r}
          </span>
        ))}
      </div>
      {row.p === null ? (
        <span />
      ) : (
        <div className="bar">
          <span style={{ width: `${Math.max(row.p * 100, 1.5)}%` }} />
        </div>
      )}
      <div className="p">{row.p === null ? "" : row.p >= 0.995 ? "1.00" : row.p.toFixed(2)}</div>
    </div>
  );
}

function Group({ item, decision }: { item: Ran; decision: DecisionFindings }) {
  const [more, setMore] = useState(false);
  const out = (item.entries[0]?.output ?? {}) as Record<string, unknown>;
  const rows = rowsOf(item, decision);
  const present = rows.filter((r) => r.on);
  const absent = rows.filter((r) => !r.on);
  const model = modelOf(item);
  const score = out as unknown as ModelScore;
  return (
    <div className="trace-signal-group">
      <div className="signal-group-head">
        <span className="wf-palette-title">
          {item.step.name}
          {model && ` · ${model}`}
        </span>
        <span className="trace-result">
          {item.step.type === "assess" && (
            <>
              <b>{valueText(out.decision)}</b>{" "}
              <span className="mono muted">
                {typeof out.probability === "number" ? out.probability.toFixed(2) : ""}
              </span>
            </>
          )}
          {item.step.type === "score" && typeof score.score === "number" && (
            <>
              <b className="mono">{score.score.toFixed(4)}</b>{" "}
              <span className="muted">risk score {score.risk_score}</span>
            </>
          )}
        </span>
      </div>
      {present.map((row) => (
        <Signal key={row.name} row={row} />
      ))}
      {absent.length > 0 && (
        <>
          <button type="button" className="linkish trace-toggle" onClick={() => setMore(!more)}>
            {more ? "Hide the signals not present" : `Show ${absent.length} more (not present)`}
          </button>
          {more && absent.map((row) => <Signal key={row.name} row={row} />)}
        </>
      )}
    </div>
  );
}

/** A workflow decision's answer, and what each model step found on the way. Nothing when no model step ran. */
export function WorkflowSignals({
  run,
  steps,
  decision,
}: {
  run: WorkflowRun;
  steps: WorkflowStep[];
  decision: DecisionFindings;
}) {
  const items = useMemo(() => traceOf(steps, run), [steps, run]);
  const ran = items.filter((i): i is Ran => i.kind === "ran" && !i.afterAnswer);
  const models = ran.filter((i) => MODEL_STEPS.has(i.step.type) && !i.entries[0]?.error);
  if (models.length === 0) return null;
  const answer = ran.find((i) => ANSWERS.has(i.step.type));
  const given = (answer?.entries[0]?.output ?? {}) as {
    outcome?: Outcome;
    reasons?: unknown[];
    probability?: number;
  };
  return (
    <section className="card pad o-signals">
      <h2>Signals</h2>
      {answer && (
        <div className="trace-answer">
          <span className="muted">"{answer.step.name}" answered</span>
          {given.outcome && <Pill outcome={given.outcome} />}
          {Array.isArray(given.reasons) && given.reasons.length > 0 && (
            <Chips items={given.reasons.map(String)} tone="accent" max={6} />
          )}
          {typeof given.probability === "number" && (
            <span className="mono muted">probability {given.probability.toFixed(4)}</span>
          )}
        </div>
      )}
      {models.map((item) => (
        <Group key={item.step.id} item={item} decision={decision} />
      ))}
      <p className="note" style={{ margin: "14px 0 0" }}>
        What each model step answered before the workflow gave its answer.
      </p>
    </section>
  );
}
