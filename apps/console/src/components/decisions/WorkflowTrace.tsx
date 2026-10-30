import { useMemo, useState, type ReactNode } from "react";
import { marksOf } from "../../hooks/useWorkflowRun";
import { valueText } from "../../lib/format";
import { slugOfRef } from "../../lib/models";
import { href } from "../../lib/route";
import { conditionSentence, eventsRead, readsOf, traceOf, type TraceItem } from "../../lib/trace";
import { kindOf, TRIGGER_KINDS } from "../../lib/workflows";
import type {
  ModelScore,
  Outcome,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStep,
  WorkflowStep,
} from "../../types/interfaces";
import { Pill } from "./Outcome";
import { Timeline } from "../events/Timeline";
import { Chips } from "../ui/Chips";
import { KV } from "../ui/KV";
import { StepIcon } from "../workflows/StepIcon";
import { WorkflowCanvas } from "../workflows/WorkflowCanvas";

type AskAnswer = { value?: unknown; values?: unknown[]; level?: string; probability?: number };
type Ran = Extract<TraceItem, { kind: "ran" }>;
type Context = { run: WorkflowRun; outcome?: Outcome; entityTypes?: Set<string> };
type Definition = { trigger: WorkflowDefinition["trigger"]; steps: WorkflowStep[] };

const p = (value: unknown) => (typeof value === "number" ? value.toFixed(2) : "—");
const answerText = (a: AskAnswer | undefined) =>
  a === undefined ? "—" : valueText(a.level ?? (a.values ? a.values.join(", ") : a.value));
const ANSWERS = new Set(["answer", "return"]);

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

function Events({ entry, outcome, entityTypes }: { entry: WorkflowRunStep } & Omit<Context, "run">) {
  const [open, setOpen] = useState(false);
  const read = eventsRead(entry);
  if (!read) return null;
  return (
    <>
      <button type="button" className="linkish trace-toggle" onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} the {read.events.length} {read.events.length === 1 ? "event" : "events"} it read
      </button>
      {open && <Timeline events={read.events} pending={read.pending} outcome={outcome} entityTypes={entityTypes} />}
    </>
  );
}

function Input({ item, run, outcome, entityTypes }: { item: Ran } & Context): ReactNode {
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
      const events = eventsRead(entry)?.events.length ?? 0;
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
          {!entry.read && <span className="muted">Not kept: this run is older than the log of model inputs.</span>}
          <Events entry={entry} outcome={outcome} entityTypes={entityTypes} />
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

function StepCell({ item }: { item: Ran }) {
  const kind = kindOf(item.step.type);
  const model =
    item.entries[0]?.read?.model ?? (item.step.type === "score" ? String(item.step.model ?? "") : undefined);
  return (
    <div style={{ paddingLeft: item.depth * 16 }} className={item.depth ? "trace-nested" : ""}>
      <div className="trace-name">
        <StepIcon icon={kind.icon} />
        <b>{item.step.name}</b>
      </div>
      <div className="trace-kind">
        {kind.label}
        {model ? (
          <>
            {" · "}
            {item.step.type === "score" ? <a href={href("settings", "models", slugOfRef(model))}>{model}</a> : model}
          </>
        ) : null}
      </div>
    </div>
  );
}

function TriggerCell({ definition }: { definition: Definition }) {
  const kind = TRIGGER_KINDS.find((k) => k.type === definition.trigger.type);
  const action = typeof definition.trigger.action === "string" ? ` · ${definition.trigger.action}` : "";
  return (
    <div>
      <div className="trace-name">
        <StepIcon icon={definition.trigger.type === "decision" ? "decision" : "trigger"} />
        <b>Trigger</b>
      </div>
      <div className="trace-kind">
        {kind?.label ?? definition.trigger.type}
        {action}
      </div>
    </div>
  );
}

function TriggerInput({ run }: { run: WorkflowRun }) {
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
  return (
    <Pairs
      data={{
        ...(entities && typeof entities === "object" ? (entities as Record<string, unknown>) : {}),
        ...(properties && typeof properties === "object" ? (properties as Record<string, unknown>) : {}),
        ...rest,
        ...(typeof ts === "string" ? { "decided as of": valueText(ts) } : {}),
      }}
    />
  );
}

function Ledger({ items, definition, ...context }: { items: TraceItem[]; definition: Definition } & Context) {
  const before = items.filter((i) => i.kind === "not_run" || !i.afterAnswer);
  const after = items.filter((i): i is Ran => i.kind === "ran" && i.afterAnswer);
  const skipped = before.filter((i) => i.kind === "not_run");
  let n = 0;
  const row = (item: Ran) => {
    const tone = ANSWERS.has(item.step.type) ? "answer" : item.entries[0]?.status === "failed" ? "failed" : "";
    return [
      <tr key={`${item.step.id}:head`} className={`head ${tone}`}>
        <td colSpan={2}>
          <span className="n">{++n}</span>
          <StepCell item={item} />
        </td>
      </tr>,
      <tr key={item.step.id} className={`io ${tone}`}>
        <td style={{ paddingLeft: 34 + item.depth * 16 }}>
          <Input item={item} {...context} />
        </td>
        <td>
          <Output item={item} />
        </td>
      </tr>,
    ];
  };
  return (
    <table className="trace-table">
      <thead>
        <tr>
          <th style={{ paddingLeft: 34 }}>Input</th>
          <th>Output</th>
        </tr>
      </thead>
      <tbody>
        <tr className="head">
          <td colSpan={2}>
            <span className="n">0</span>
            <TriggerCell definition={definition} />
          </td>
        </tr>
        <tr className="io">
          <td style={{ paddingLeft: 34 }}>
            <TriggerInput run={context.run} />
          </td>
          <td>
            <span className="muted">Started the run</span>
          </td>
        </tr>
        {before.filter((i): i is Ran => i.kind === "ran").map(row)}
        {skipped.length > 0 && (
          <tr className="skip">
            <td colSpan={2}>
              Not run:{" "}
              {skipped
                .map(
                  (s) => `${s.steps.map((x) => x.name).join(", ")} (${s.why.replace(/^The /, "the ").toLowerCase()})`,
                )
                .join(" · ")}
            </td>
          </tr>
        )}
        {after.length > 0 && (
          <tr className="group">
            <td colSpan={2}>After the answer, once the decision was saved</td>
          </tr>
        )}
        {after.map(row)}
      </tbody>
    </table>
  );
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

function Summary({ items, run }: { items: TraceItem[]; run: WorkflowRun }) {
  const ran = items.filter((i): i is Ran => i.kind === "ran" && !i.afterAnswer);
  const answer = ran.find((i) => ANSWERS.has(i.step.type));
  const outcome = (answer?.entries[0]?.output as { outcome?: Outcome } | undefined)?.outcome;
  if (!answer || !outcome) return null;
  const because = ran
    .filter((i) => i.step.type === "condition" || i.step.type === "filter")
    .map((i) => conditionSentence(i.step, i.entries[0]!, run));
  return (
    <div className="trace-summary">
      <Pill outcome={outcome} />{" "}
      {because.length
        ? `because ${because.slice(0, -1).join(", ")}${because.length > 1 ? ", and " : ""}${because.at(-1)}.`
        : `: the answer of "${answer.step.name}".`}
    </div>
  );
}

/** How a decision workflow reached its answer: each step it ran, with its input and its output. */
export function WorkflowTrace({ run, definition, outcome, entityTypes }: { definition: Definition } & Context) {
  const [view, setView] = useState<"steps" | "flow">("steps");
  const items = useMemo(() => traceOf(definition.steps, run), [definition.steps, run]);
  const context = { run, outcome, entityTypes };
  return (
    <div className="trace">
      <div className="trace-bar">
        <Summary items={items} run={run} />
        <div className="seg" role="tablist">
          {(["steps", "flow"] as const).map((v) => (
            <button key={v} type="button" className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {v === "steps" ? "Steps" : "Flow"}
            </button>
          ))}
        </div>
      </div>
      {view === "steps" ? (
        <Ledger items={items} definition={definition} {...context} />
      ) : (
        <Flow definition={definition} items={items} {...context} />
      )}
    </div>
  );
}
