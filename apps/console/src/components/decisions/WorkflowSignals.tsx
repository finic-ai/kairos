import { valueText } from "../../lib/format";
import { slugOfRef } from "../../lib/models";
import { href } from "../../lib/route";
import { traceOf, type TraceItem } from "../../lib/trace";
import type { Outcome, WorkflowRun, WorkflowStep } from "../../types/interfaces";
import { Chips } from "../ui/Chips";
import { Pill } from "./Outcome";

type Ran = Extract<TraceItem, { kind: "ran" }>;
type Answer = { value?: unknown; values?: unknown[]; level?: string; probability?: number; probabilities?: unknown };
interface Signal {
  name: string;
  desc: string;
  p: number | null;
  on: boolean;
  text?: string;
}

const ANSWERS = new Set(["answer", "return"]);

function signalsOf(item: Ran, actionSignals: ActionSignals | undefined): Signal[] {
  const out = (item.entries[0]?.output ?? {}) as Record<string, unknown>;
  switch (item.step.type) {
    case "ask": {
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
        return {
          name: key,
          desc: q.question ?? "",
          p,
          on: q.type === "yes_no" ? a?.value === true : chosen !== undefined,
          ...(q.type === "yes_no" ? {} : { text: valueText(chosen) }),
        };
      });
    }
    case "assess": {
      const hold: Signal = {
        name: "hold",
        desc: `The action's model: ${valueText(out.decision)}`,
        p: typeof out.probability === "number" ? out.probability : null,
        on: out.decision !== "approve",
      };
      const reasons = (actionSignals?.signals ?? []).map(([code, p]) => ({
        name: code,
        desc: actionSignals?.descriptions?.[code] ?? "",
        p,
        on: p >= (actionSignals?.threshold ?? 0.5),
      }));
      return [hold, ...reasons];
    }
    case "score":
      return [
        {
          name: String(out.model ?? item.step.model ?? ""),
          desc: "The scoring model's score",
          p: typeof out.score === "number" ? out.score : null,
          on: false,
        },
      ];
    default:
      return [];
  }
}

export interface ActionSignals {
  signals: [string, number][];
  descriptions?: Record<string, string>;
  threshold: number;
}

/** A workflow decision's answer, and what each model step answered on the way, as an action's signals are shown. */
export function WorkflowSignals({
  run,
  steps,
  actionSignals,
}: {
  run: WorkflowRun;
  steps: WorkflowStep[];
  actionSignals?: ActionSignals;
}) {
  const ran = traceOf(steps, run).filter((i): i is Ran => i.kind === "ran" && !i.afterAnswer);
  const answer = ran.find((i) => ANSWERS.has(i.step.type));
  const given = (answer?.entries[0]?.output ?? {}) as {
    outcome?: Outcome;
    reasons?: unknown[];
    probability?: number;
    risk_score?: number;
  };
  const groups = ran.map((item) => ({ item, signals: signalsOf(item, actionSignals) })).filter((g) => g.signals.length);
  return (
    <>
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
      {groups.map(({ item, signals }) => (
        <div key={item.step.id} className="trace-signal-group">
          <div className="wf-palette-title">
            {item.step.name}
            {item.step.type === "score" && typeof item.step.model === "string" && (
              <>
                {" · "}
                <a href={href("settings", "models", slugOfRef(item.step.model))}>{item.step.model}</a>
              </>
            )}
          </div>
          {signals.map((s) => (
            <div key={s.name} className={`signal ${s.on ? "on" : ""}`}>
              <span className="dot" />
              <div>
                <div className="name">{s.name}</div>
                {s.desc && <div className="desc">{s.desc}</div>}
              </div>
              <div className="bar">{s.p !== null && <span style={{ width: `${Math.max(s.p * 100, 1.5)}%` }} />}</div>
              <div className="p">{s.text ?? (s.p === null ? "—" : s.p >= 0.995 ? "1.00" : s.p.toFixed(2))}</div>
            </div>
          ))}
        </div>
      ))}
      <p className="note" style={{ margin: "14px 0 0" }}>
        What each model step answered before the workflow gave its answer. A filled dot is a yes, or a signal that is
        present. The steps below show how the answers led to the outcome.
      </p>
    </>
  );
}
