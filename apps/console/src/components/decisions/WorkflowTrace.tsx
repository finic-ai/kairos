import { useMemo, useState, type ReactNode } from "react";
import { marksOf } from "../../hooks/useWorkflowRun";
import { valueText } from "../../lib/format";
import { slugOfRef } from "../../lib/models";
import { href } from "../../lib/route";
import { eventsRead, readsOf, traceOf, type TraceItem } from "../../lib/trace";
import { kindOf, TRIGGER_KINDS } from "../../lib/workflows";
import type {
  KairosEvent,
  ModelScore,
  Outcome,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
} from "../../types/interfaces";
import { Pill } from "./Outcome";
import { Timeline } from "../events/Timeline";
import { Chips } from "../ui/Chips";
import { KV } from "../ui/KV";
import { StepIcon } from "../workflows/StepIcon";
import { WorkflowCanvas } from "../workflows/WorkflowCanvas";

type AskAnswer = { value?: unknown; values?: unknown[]; level?: string; probability?: number };
export type Ran = Extract<TraceItem, { kind: "ran" }>;
type Context = { run: WorkflowRun; outcome?: Outcome; entityTypes?: Set<string>; decision?: DecisionRead };
/** What the model read for the decision itself: the fallback for a run that did not log its model input. */
export type DecisionRead = {
  action: string;
  events: KairosEvent[];
  pending?: Record<string, unknown>;
  /** The decision's reason probabilities, highest first. */
  signals?: [string, number][];
};
type Definition = { trigger: WorkflowDefinition["trigger"]; steps: WorkflowStep[] };

const p = (value: unknown) => (typeof value === "number" ? value.toFixed(2) : "—");
const answerText = (a: AskAnswer | undefined) =>
  a === undefined ? "—" : valueText(a.level ?? (a.values ? a.values.join(", ") : a.value));
export const ANSWERS = new Set(["answer", "return"]);

function Pairs({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return null;
  return (
    <div className="trace-kv">
      {entries.map(([k, v]) => (
        <div key={k}>
          <span>{k}</span>
          <span className="mono">{v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : valueText(v)}</span>
        </div>
      ))}
    </div>
  );
}

function modelRead(item: Ran, decision: DecisionRead | undefined) {
  const entry = item.entries[0]!;
  const logged = eventsRead(entry);
  if (logged) return logged;
  const action = (entry.output as { action?: unknown } | undefined)?.action;
  if (item.step.type === "assess" && decision && action === decision.action)
    return { events: decision.events, ...(decision.pending ? { pending: decision.pending } : {}) };
  return null;
}

function Events({ item, outcome, entityTypes, decision }: { item: Ran } & Omit<Context, "run">) {
  const [open, setOpen] = useState(false);
  const read = modelRead(item, decision);
  if (!read) return null;
  return (
    <>
      <button type="button" className="linkish trace-toggle" onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"}{" "}
        {read.events.length === 0
          ? "the request it read (there were no earlier events)"
          : `the ${read.events.length} ${read.events.length === 1 ? "event" : "events"} it read`}
      </button>
      {open && <Timeline events={read.events} pending={read.pending} outcome={outcome} entityTypes={entityTypes} />}
    </>
  );
}

function Input({
  item,
  run,
  outcome,
  entityTypes,
  decision,
  events: withEvents = true,
}: { item: Ran; events?: boolean } & Context): ReactNode {
  const { step } = item;
  const entry = item.entries[0]!;
  const input = entry.input;
  if (input?.truncated) return <span className="muted">Too large to keep in the log.</span>;
  switch (step.type) {
    case "condition":
    case "filter":
    case "loop": {
      const expression = String(step.when ?? step.over ?? "");
      return (
        <>
          <code className="trace-when">{expression}</code>
          <Pairs data={input?.reads ?? Object.fromEntries(readsOf(expression, run))} />
        </>
      );
    }
    case "ask":
    case "assess": {
      const context = entry.read?.context ?? {};
      const subject = context.subject as { type?: string; id?: string; labels?: string[] } | undefined;
      const read = modelRead(item, decision);
      const events = read?.events.length ?? 0;
      const about = subject?.id
        ? {
            about: `${subject.type} ${subject.id}`,
            events,
            ...(subject.labels?.length ? { labels: subject.labels.join(", ") } : {}),
          }
        : {};
      const asked = (context.data ?? (step.type === "assess" ? context.pending_action : undefined)) as
        Record<string, unknown> | undefined;
      const { type: _t, requested_at: _r, ...request } = asked ?? {};
      return (
        <>
          <Pairs data={{ ...about, ...request }} />
          {!read && <span className="muted">Not kept: this run is older than the log of model inputs.</span>}
          {withEvents && <Events item={item} outcome={outcome} entityTypes={entityTypes} decision={decision} />}
        </>
      );
    }
    case "score": {
      const s = entry.output as ModelScore | undefined;
      return s?.features ? (
        <>
          <Pairs data={s.features} />
          {s.missing.length > 0 && <Chips items={s.missing.map((m) => `${m}: missing`)} tone="warn" max={6} />}
        </>
      ) : (
        <Pairs data={(input?.features as Record<string, unknown>) ?? {}} />
      );
    }
    case "answer":
    case "return":
      return <span className="muted">—</span>;
    default: {
      const { model: _m, ...rest } = input ?? {};
      return Object.keys(rest).length ? <Pairs data={rest} /> : <span className="muted">—</span>;
    }
  }
}

function Output({ item }: { item: Ran }): ReactNode {
  const { step, entries } = item;
  const entry = entries[0]!;
  const out = (entry.output ?? {}) as Record<string, unknown>;
  if (entry.error) return <span className="wh-failed">{entry.error}</span>;
  if (entries.length > 1 && step.type !== "loop") return <span>Ran {entries.length} times, once for each item.</span>;
  switch (step.type) {
    case "condition":
      return (
        <span>
          <b>{out.branch === "then" ? "true" : "false"}</b> → {String(out.branch ?? "")}
        </span>
      );
    case "filter":
      return <b>{out.passed ? "passed" : "filtered out"}</b>;
    case "ask": {
      const questions = (step.questions ?? {}) as Record<string, { question?: string }>;
      return (
        <div className="trace-kv">
          {Object.entries(questions).map(([key, q]) => {
            const a = out[key] as AskAnswer | undefined;
            return (
              <div key={key} className="answer">
                <span>{q.question || key}</span>
                <span className="nowrap">
                  <b>{answerText(a)}</b>
                  {typeof a?.probability === "number" && <span className="muted mono"> · {p(a.probability)}</span>}
                </span>
              </div>
            );
          })}
        </div>
      );
    }
    case "assess":
      return (
        <span>
          <b>{valueText(out.decision)}</b> <span className="mono">· {p(out.probability)}</span>
          {Array.isArray(out.reasons) && out.reasons.length > 0 && <Chips items={out.reasons.map(String)} max={4} />}
        </span>
      );
    case "score": {
      const s = out as unknown as ModelScore;
      return (
        <span>
          <b className="mono">{typeof s.score === "number" ? s.score.toFixed(4) : "—"}</b>{" "}
          <span className="muted">risk score {s.risk_score}</span>
        </span>
      );
    }
    case "answer":
    case "return": {
      const { outcome, reasons, ...rest } = out as { outcome?: Outcome; reasons?: unknown[] };
      return (
        <div>
          {outcome && <Pill outcome={outcome} />}{" "}
          {Array.isArray(reasons) && reasons.length > 0 && <Chips items={reasons.map(String)} max={4} />}
          <Pairs data={rest} />
        </div>
      );
    }
    case "decide":
      return (
        <span>
          <b>{valueText(out.decision)}</b>
          {typeof out.decision_id === "string" && (
            <>
              {" "}
              · <a href={href("decisions", out.decision_id)}>the decision</a>
            </>
          )}
        </span>
      );
    case "http":
      return <span className="mono">{valueText(out.status)}</span>;
    case "record.search":
    case "loop":
      return <span>{Array.isArray(entry.output) ? entry.output.length : 0} found</span>;
    default:
      return entry.output === undefined ? <span className="muted">—</span> : <Pairs data={out} />;
  }
}

const DEFAULT_MODEL = "grayson-1";
const MODEL_STEPS = new Set(["assess", "ask", "score"]);

export function modelOf(item: Ran): string | undefined {
  if (!MODEL_STEPS.has(item.step.type)) return undefined;
  const named = item.entries[0]?.read?.model ?? (typeof item.step.model === "string" ? item.step.model : undefined);
  return named || (item.step.type === "score" ? undefined : DEFAULT_MODEL);
}

function ModelRef({ item }: { item: Ran }) {
  const model = modelOf(item);
  const action = (item.entries[0]?.output as { action?: unknown } | undefined)?.action;
  if (!model) return null;
  return (
    <>
      {" · "}
      {model === DEFAULT_MODEL ? (
        <span className="mono">{model}</span>
      ) : (
        <a className="mono" href={href("settings", "models", slugOfRef(model))}>
          {model}
        </a>
      )}
      {item.step.type === "assess" && typeof action === "string" && (
        <>
          {" for "}
          <span className="mono">{action}</span>
        </>
      )}
    </>
  );
}

function StepCell({ item }: { item: Ran }) {
  const kind = kindOf(item.step.type);
  return (
    <div style={{ paddingLeft: item.depth * 16 }} className={item.depth ? "trace-nested" : ""}>
      <div className="trace-name">
        <StepIcon icon={kind.icon} />
        <b>{item.step.name}</b>
      </div>
      <div className="trace-kind">
        {kind.label}
        <ModelRef item={item} />
      </div>
    </div>
  );
}

function triggerKind(definition: Definition) {
  const kind = TRIGGER_KINDS.find((k) => k.type === definition.trigger.type);
  const action = typeof definition.trigger.action === "string" ? ` · ${definition.trigger.action}` : "";
  return `${kind?.label ?? definition.trigger.type}${action}`;
}

function TriggerCell({ definition }: { definition: Definition }) {
  return (
    <div>
      <div className="trace-name">
        <StepIcon icon={definition.trigger.type === "decision" ? "decision" : "trigger"} />
        <b>Trigger</b>
      </div>
      <div className="trace-kind">{triggerKind(definition)}</div>
    </div>
  );
}

function triggerFacts(run: WorkflowRun): Record<string, unknown> {
  const {
    live_steps: _l,
    mock_outputs: _m,
    decision_id: _d,
    action: _a,
    entities,
    properties,
    ts,
    ...rest
  } = run.trigger as Record<string, unknown>;
  return {
    ...(entities && typeof entities === "object" ? (entities as Record<string, unknown>) : {}),
    ...(properties && typeof properties === "object" ? (properties as Record<string, unknown>) : {}),
    ...rest,
    ...(typeof ts === "string" ? { "decided as of": valueText(ts) } : {}),
  };
}

function TriggerInput({ run }: { run: WorkflowRun }) {
  return <Pairs data={triggerFacts(run)} />;
}

function Flow({ definition, items, ...context }: { definition: Definition; items: TraceItem[] } & Context) {
  const marks = useMemo(() => marksOf(context.run), [context.run]);
  const [selected, setSelected] = useState<string | null>(null);
  const item = items.find((i): i is Ran => i.kind === "ran" && i.step.id === selected);
  return (
    <div className="trace-flow">
      <div className="trace-canvas">
        <WorkflowCanvas definition={definition} marks={marks} selected={selected} onSelect={setSelected} />
      </div>
      <div className="trace-panel">
        {selected === "trigger" ? (
          <>
            <TriggerCell definition={definition} />
            <div className="trace-panel-part">Input</div>
            <TriggerInput run={context.run} />
          </>
        ) : item ? (
          <>
            <StepCell item={item} />
            <div className="trace-panel-part">Input</div>
            <Input item={item} {...context} />
            <div className="trace-panel-part">Output</div>
            <Output item={item} />
          </>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {selected ? "This step did not run." : "Click a step to see its input and output."}
          </p>
        )}
      </div>
    </div>
  );
}

type NotRun = Extract<TraceItem, { kind: "not_run" }>;
type Decisive = { item: Ran; kind: "path" | "answer" };

const shortName = (path: string) => path.split(".").at(-1)!;
const shownValue = (v: unknown) =>
  v === undefined || v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : valueText(v);

function readsFor(item: Ran, run: WorkflowRun): [string, unknown][] {
  const logged = item.entries[0]?.input?.reads as Record<string, unknown> | undefined;
  if (logged) return Object.entries(logged);
  return readsOf(String(item.step.when ?? item.step.over ?? ""), run);
}

/** The step that settled the outcome: the model step the answer repeats, or the condition that led to the answer. */
function decisiveOf(items: TraceItem[]): Decisive | null {
  const ran = items.filter((i): i is Ran => i.kind === "ran" && !i.afterAnswer);
  const answer = ran.find((i) => ANSWERS.has(i.step.type));
  if (!answer) return null;
  const outcome = (answer.step.value as Record<string, unknown> | undefined)?.outcome;
  const ref = typeof outcome === "string" ? /steps\.([A-Za-z_]\w*)\./.exec(outcome)?.[1] : undefined;
  const source = ref ? ran.find((i) => i.step.id === ref) : undefined;
  if (source) return { item: source, kind: "answer" };
  const parent = ran.find((i) => i.step.id === answer.parent && i.step.type === "condition");
  return parent ? { item: parent, kind: "path" } : null;
}

function Reads({ data, label = "read" }: { data: [string, unknown][]; label?: string }) {
  if (data.length === 0) return null;
  return (
    <div className="trace-reads">
      {label && <span>{label}</span>}
      {data.map(([k, v]) => (
        <span key={k} title={k}>
          {shortName(k)} <b className="mono">{shownValue(v)}</b>
        </span>
      ))}
    </div>
  );
}

function Result({ item }: { item: Ran }): ReactNode {
  const entry = item.entries[0]!;
  const out = (entry.output ?? {}) as Record<string, unknown>;
  if (entry.error) return <span className="wh-failed">Failed</span>;
  if (item.entries.length > 1 && item.step.type !== "loop") return <span>Ran {item.entries.length} times</span>;
  switch (item.step.type) {
    case "condition":
      return (
        <span>
          <b>{out.branch === "then" ? "Yes" : "No"}</b> <span className="muted">→ {String(out.branch ?? "else")}</span>
        </span>
      );
    case "filter":
      return <b>{out.passed ? "Passed" : "Filtered out"}</b>;
    case "assess":
      return (
        <span>
          <b>{valueText(out.decision)}</b> <span className="mono muted">{p(out.probability)}</span>
        </span>
      );
    case "score": {
      const s = out as unknown as ModelScore;
      return (
        <span>
          <b className="mono">{typeof s.score === "number" ? s.score.toFixed(4) : "—"}</b>{" "}
          <span className="muted">risk score {s.risk_score}</span>
        </span>
      );
    }
    case "answer":
    case "return":
      return out.outcome ? <Pill outcome={out.outcome as Outcome} /> : null;
    case "decide":
      return (
        <span>
          <b>{valueText(out.decision)}</b>
          {typeof out.decision_id === "string" && (
            <>
              {" "}
              · <a href={href("decisions", out.decision_id)}>the decision</a>
            </>
          )}
        </span>
      );
    case "case.create":
      return typeof out.case_id === "string" ? (
        <span>
          <a className="mono" href={href("cases", out.case_id)}>
            {out.case_id}
          </a>{" "}
          <span className="muted">· {out.created ? "new case" : "existing case"}</span>
        </span>
      ) : null;
    case "http":
      return <span className="mono">{valueText(out.status)}</span>;
    case "record.search":
    case "loop":
      return <span>{Array.isArray(entry.output) ? entry.output.length : 0} found</span>;
    default:
      return null;
  }
}

function Signals({ signals }: { signals: [string, number][] }) {
  return (
    <div className="trace-bars">
      {signals.map(([code, value]) => (
        <div key={code}>
          <span>{code}</span>
          <i>
            <span style={{ width: `${Math.max(value * 100, 1.5)}%` }} />
          </i>
          <span className="mono">{value >= 0.995 ? "1.00" : value.toFixed(2)}</span>
        </div>
      ))}
    </div>
  );
}

const TOP_SIGNALS = 3;

/** A "Get the model's decision" step's reason probabilities: its own when the run kept them, else the decision's. */
function stepSignals(item: Ran, decision: DecisionRead | undefined): [string, number][] {
  if (item.step.type !== "assess") return [];
  const entry = item.entries[0]!;
  const logged = (entry.read as { answers?: { reasons?: { probabilities?: Record<string, number> } } } | undefined)
    ?.answers?.reasons?.probabilities;
  if (logged) return Object.entries(logged).sort((a, b) => b[1] - a[1]);
  const action = (entry.output as { action?: unknown } | undefined)?.action;
  return decision?.signals && action === decision.action ? decision.signals : [];
}

function Body({ item, ...context }: { item: Ran } & Context): ReactNode {
  const { run } = context;
  const entry = item.entries[0]!;
  const out = (entry.output ?? {}) as Record<string, unknown>;
  if (entry.error) return <div className="wh-failed">{entry.error}</div>;
  switch (item.step.type) {
    case "condition":
    case "filter":
    case "loop":
      return <Reads data={readsFor(item, run)} />;
    case "assess": {
      const signals = stepSignals(item, context.decision);
      return (
        <>
          {signals.length ? (
            <Signals signals={signals.slice(0, TOP_SIGNALS)} />
          ) : Array.isArray(out.reasons) && out.reasons.length ? (
            <Chips items={out.reasons.map(String)} max={6} />
          ) : null}
          <Events item={item} {...context} />
        </>
      );
    }
    case "score": {
      const s = out as unknown as ModelScore;
      return (
        <>
          <Reads data={Object.entries(s.features ?? {})} />
          {s.missing?.length > 0 && <Chips items={s.missing.map((m) => `${m}: missing`)} tone="warn" max={6} />}
        </>
      );
    }
    case "ask":
      return (
        <>
          <Output item={item} />
          <Events item={item} {...context} />
        </>
      );
    case "answer":
    case "return": {
      const {
        outcome: _o,
        rules,
        reasons,
        risk_score,
        ...rest
      } = out as {
        outcome?: Outcome;
        rules?: unknown[];
        reasons?: unknown[];
        risk_score?: number;
      };
      return (
        <>
          {(typeof risk_score === "number" || (Array.isArray(rules) && rules.length > 0)) && (
            <div className="trace-reads">
              {typeof risk_score === "number" && (
                <span>
                  risk score <b className="mono">{risk_score}</b>
                </span>
              )}
              {Array.isArray(rules) && rules.length > 0 && (
                <span>
                  rules <Chips items={rules.map(String)} tone="accent" max={6} />
                </span>
              )}
            </div>
          )}
          {Array.isArray(reasons) && reasons.length > 0 && (
            <div className="trace-reads">
              <span>
                reasons <Chips items={reasons.map(String)} max={6} />
              </span>
            </div>
          )}
          <Pairs data={rest} />
        </>
      );
    }
    case "decide":
    case "http":
    case "case.create":
    case "record.search":
      return null;
    default:
      return entry.output === undefined ? null : <Output item={item} />;
  }
}

function Details({ item, ...context }: { item: Ran } & Context) {
  const [open, setOpen] = useState(false);
  const type = item.step.type;
  const rule = type === "condition" || type === "filter" || type === "loop";
  const hasInput = rule || type === "ask" || type === "assess" || type === "score";
  if (!hasInput || item.entries[0]?.error) return null;
  const signals = stepSignals(item, context.decision);
  const hidden = signals.length - TOP_SIGNALS;
  const label = rule ? "the rule" : hidden > 0 ? `all ${signals.length} signals and the input` : "the input";
  return (
    <>
      <button type="button" className="linkish trace-toggle" onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} {label}
      </button>
      {open && (
        <div className="trace-detail">
          {rule ? (
            <code className="trace-when">{String(item.step.when ?? item.step.over ?? "")}</code>
          ) : (
            <>
              {hidden > 0 && <Signals signals={signals.slice(TOP_SIGNALS)} />}
              <Input item={item} {...context} events={false} />
            </>
          )}
        </div>
      )}
    </>
  );
}

function Skipped({ item }: { item: NotRun }) {
  return (
    <div className="trace-skipped">
      Not run: {item.steps.map((s) => s.name).join(" · ")} ({item.why.toLowerCase()})
    </div>
  );
}

function Branches({ item }: { item: Ran }) {
  const taken = (item.entries[0]?.output as { branch?: string } | undefined)?.branch === "then" ? "then" : "else";
  const names = (branch: "then" | "else") =>
    ((item.step[branch] as WorkflowStep[] | undefined) ?? []).map((s) => s.name).join(" · ");
  return (
    <div className="trace-branches">
      {(["then", "else"] as const).map((branch) => (
        <div key={branch} className={branch === taken ? "taken" : ""}>
          <span>{branch === "then" ? "If yes" : "If no"}</span>
          <span>{names(branch) || "Nothing: the run goes on"}</span>
          <span>{branch === taken ? "Taken" : "Skipped"}</span>
        </div>
      ))}
    </div>
  );
}

function Steps({
  items,
  definition,
  decisive,
  ...context
}: { items: TraceItem[]; definition: Definition; decisive: Decisive | null } & Context) {
  const before = items.filter((i) => (i.kind === "not_run" ? !i.branch : !i.afterAnswer));
  const after = items.filter((i): i is Ran => i.kind === "ran" && i.afterAnswer);
  let n = 0;
  const step = (item: Ran) => {
    const answer = ANSWERS.has(item.step.type);
    const failed = item.entries[0]?.status === "failed";
    const decided = decisive?.item === item;
    const kind = kindOf(item.step.type);
    return (
      <li
        key={item.step.id}
        className={`trace-step${answer && !item.afterAnswer ? " answer" : ""}${failed ? " failed" : ""}${decided || (answer && !item.afterAnswer) ? " decisive" : ""}`}
      >
        <span className="trace-n">{++n}</span>
        <div className="trace-body">
          <div className="trace-top">
            <span className="trace-title">
              <StepIcon icon={kind.icon} />
              <b>{item.step.name}</b>
              <span className="trace-kind">
                {kind.label}
                <ModelRef item={item} />
              </span>
              {decided && (
                <span className="trace-tag">
                  {decisive!.kind === "answer" ? "Gave the answer" : "Decided the path"}
                </span>
              )}
            </span>
            <span className="trace-result">
              <Result item={item} />
            </span>
          </div>
          <Body item={item} {...context} />
          {item.step.type === "condition" && !item.entries[0]?.error && <Branches item={item} />}
          <Details item={item} {...context} />
        </div>
      </li>
    );
  };
  return (
    <ol className="trace-steps">
      <li className="trace-step">
        <span className="trace-n">0</span>
        <div className="trace-body">
          <div className="trace-top">
            <span className="trace-title">
              <StepIcon icon={definition.trigger.type === "decision" ? "decision" : "trigger"} />
              <b>Trigger</b>
              <span className="trace-kind">{triggerKind(definition)}</span>
            </span>
          </div>
          <Reads data={Object.entries(triggerFacts(context.run))} label="" />
        </div>
      </li>
      {before.map((item) =>
        item.kind === "ran" ? (
          step(item)
        ) : (
          <li key={`skip:${item.steps[0]!.id}`} className="trace-step skip">
            <span className="trace-n" />
            <div className="trace-body">
              <Skipped item={item} />
            </div>
          </li>
        ),
      )}
      {after.length > 0 && <li className="trace-group">After the answer, once the decision was saved</li>}
      {after.map(step)}
    </ol>
  );
}

function summaryOf(items: TraceItem[], decisive: Decisive | null, run: WorkflowRun) {
  const answer = items.find((i): i is Ran => i.kind === "ran" && !i.afterAnswer && ANSWERS.has(i.step.type));
  const outcome = (answer?.entries[0]?.output as { outcome?: Outcome } | undefined)?.outcome;
  if (!answer || !outcome) return null;
  let text = `The answer of "${answer.step.name}".`;
  if (decisive?.kind === "answer") {
    const out = (decisive.item.entries[0]?.output ?? {}) as Record<string, unknown>;
    const said =
      decisive.item.step.type === "assess"
        ? `${valueText(out.decision)}, ${p(out.probability)}`
        : decisive.item.step.type === "score" && typeof out.score === "number"
          ? out.score.toFixed(4)
          : "";
    const model = modelOf(decisive.item);
    text = `Decided by "${decisive.item.step.name}"${model ? ` (${model})` : ""}${said ? `: ${said}` : ""}.`;
  } else if (decisive) {
    const reads = readsFor(decisive.item, run)
      .map(([k, v]) => `${shortName(k)} ${shownValue(v)}`)
      .join(", ");
    const held = (decisive.item.entries[0]?.output as { branch?: string } | undefined)?.branch === "then";
    text = `Decided by "${decisive.item.step.name}"${reads ? `: ${reads}` : held ? ", which was true" : ", which was false"}.`;
  }
  return { outcome, text };
}

/** How a decision workflow reached its answer: each step it ran, with its input and its output. */
export function WorkflowTrace({
  run,
  definition,
  outcome,
  entityTypes,
  decision,
}: { definition: Definition } & Context) {
  const [view, setView] = useState<"steps" | "flow">("steps");
  const items = useMemo(() => traceOf(definition.steps, run), [definition.steps, run]);
  const decisive = useMemo(() => decisiveOf(items), [items]);
  const summary = summaryOf(items, decisive, run);
  const context = { run, outcome, entityTypes, decision };
  return (
    <div className="trace">
      <div className="trace-summary">
        <span>
          {summary ? (
            <>
              <Pill outcome={summary.outcome} /> {summary.text}
            </>
          ) : (
            <span className="muted">The steps the run took, with what each one read and gave.</span>
          )}
        </span>
        <div className="seg" role="tablist">
          {(["steps", "flow"] as const).map((v) => (
            <button key={v} type="button" className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {v === "steps" ? "Steps" : "Flow"}
            </button>
          ))}
        </div>
      </div>
      {view === "steps" ? (
        <Steps items={items} definition={definition} decisive={decisive} {...context} />
      ) : (
        <Flow definition={definition} items={items} {...context} />
      )}
    </div>
  );
}
