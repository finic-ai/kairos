import { useEffect, useState } from "react";
import { checkAnswers, conditionFields, fieldsOf, kindOf, type FieldDef } from "../../lib/workflows";
import { ancestorsOf, readableBefore, walk } from "../../lib/workflowTree";
import { isUploaded, modelOfStep, slugOfRef } from "../../lib/models";
import type { ModelSummary, UploadedModel, WorkflowDraft, WorkflowStep } from "../../types/interfaces";
import { ChoiceSelect } from "../ui/ChoiceSelect";
import { ConditionBuilder } from "./ConditionBuilder";
import { FeaturesEditor } from "./FeaturesEditor";
import { QuestionsEditor } from "./QuestionsEditor";
import { StepIcon } from "./StepIcon";

export interface Suggestions {
  actions: string[];
  entityTypes: string[];
  eventTypes: string[];
  /** The property names of the events Kairos has seen, for the fields of a condition. */
  eventProperties: string[];
  queues: { id: string; name: string }[];
  models: ModelSummary[];
  /** The published rulesets, with the inputs of their live version. */
  rulesets: { slug: string; name: string; version: number; inputs: string[] }[];
  /** The slugs of the lists. */
  lists: string[];
}

function ModelSelect({
  def,
  text,
  models,
  onChange,
}: {
  def: FieldDef;
  text: string;
  models: ModelSummary[];
  onChange: (v: string) => void;
}) {
  const options =
    def.modelKind === "scoring"
      ? [
          { value: "", label: "Choose a model" },
          ...models
            .filter((m): m is UploadedModel => isUploaded(m) && m.status === "active")
            .flatMap((m) => [
              { value: `${m.slug}@${m.version}`, label: `${m.name} · version ${m.version}` },
              { value: m.slug, label: `${m.name} · the latest version` },
            ]),
        ]
      : [
          { value: "", label: "Default: grayson-1" },
          ...models
            .filter((m) => m.kind === "question")
            .map((m) => ({ value: m.slug, label: `${m.name} (${m.slug})` })),
        ];
  return (
    <select className="input mono" value={text} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {text && !options.some((o) => o.value === text) && <option value={text}>{text}</option>}
    </select>
  );
}

const COMMON = new Set(["id", "name", "type", "retry", "on_fail", "then", "else", "steps", "record"]);

/** A JSON field keeps its text while it is not valid JSON yet; the step gets the value once it is. */
export function JsonField({
  value,
  onChange,
  placeholder,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  placeholder?: string;
}) {
  const shown = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    // A change from outside (undo, another field) shows; the person's own text is kept while it is not valid.
    setText((current) => {
      try {
        if (current.trim() && JSON.stringify(JSON.parse(current)) === JSON.stringify(value)) return current;
      } catch {
        return current;
      }
      return shown;
    });
  }, [shown, value]);
  return (
    <>
      <textarea
        className={`input mono ${bad ? "bad" : ""}`}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            setBad(false);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <small className="wh-failed">Not valid JSON yet. A text with {"{{ }}"} goes in quotes.</small>}
    </>
  );
}

function Field({
  def,
  step,
  set,
  suggestions,
  conditionFields: fieldsForCondition,
}: {
  def: FieldDef;
  step: WorkflowStep;
  set: (field: string, value: unknown) => void;
  suggestions: Suggestions;
  conditionFields: string[];
}) {
  const raw = step[def.field];
  const text = raw === undefined || raw === null ? "" : typeof raw === "string" ? raw : String(raw);
  const control = (() => {
    switch (def.kind) {
      case "select":
        return (
          <select
            className="input"
            value={text || def.options?.[0]?.value}
            onChange={(e) => set(def.field, e.target.value)}
          >
            {def.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        );
      case "event":
        return (
          <ChoiceSelect
            mono
            value={text}
            options={suggestions.eventTypes}
            placeholder="Choose an event type"
            other="Another event type…"
            onChange={(v) => set(def.field, v)}
          />
        );
      case "entity":
        return (
          <ChoiceSelect
            mono
            value={text}
            options={suggestions.entityTypes}
            placeholder="Choose an entity type"
            other="Another entity type…"
            onChange={(v) => set(def.field, v)}
          />
        );
      case "action":
        return (
          <ChoiceSelect
            mono
            value={text}
            options={suggestions.actions}
            placeholder="Choose an action"
            onChange={(v) => set(def.field, v)}
          />
        );
      case "queue":
        return (
          <select className="input" value={text} onChange={(e) => set(def.field, e.target.value || undefined)}>
            <option value="">{step.type === "record.search" ? "Any queue" : "Choose a queue"}</option>
            {suggestions.queues.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
            {text && !suggestions.queues.some((q) => q.id === text) && <option value={text}>{text}</option>}
          </select>
        );
      case "boolean":
        return (
          <input
            type="checkbox"
            checked={raw === true}
            onChange={(e) => set(def.field, e.target.checked || undefined)}
          />
        );
      case "condition":
        return (
          <ConditionBuilder
            value={text}
            fields={fieldsForCondition}
            lists={suggestions.lists}
            placeholder={def.placeholder}
            onChange={(cel) => set(def.field, cel)}
          />
        );
      case "expression":
        return (
          <textarea
            className="input mono"
            rows={2}
            placeholder={def.placeholder}
            value={text}
            onChange={(e) => set(def.field, e.target.value)}
          />
        );
      case "json":
        return <JsonField value={raw} placeholder={def.placeholder} onChange={(v) => set(def.field, v)} />;
      case "questions":
        return <QuestionsEditor stepId={step.id} value={raw} onChange={(v) => set(def.field, v)} />;
      case "model":
        return <ModelSelect def={def} text={text} models={suggestions.models} onChange={(v) => set(def.field, v)} />;
      case "ruleset":
        return (
          <select className="input mono" value={text} onChange={(e) => set(def.field, e.target.value)}>
            <option value="">Choose a ruleset</option>
            {suggestions.rulesets.flatMap((r) => [
              <option key={`${r.slug}@${r.version}`} value={`${r.slug}@${r.version}`}>
                {r.name} · version {r.version}
              </option>,
              <option key={r.slug} value={r.slug}>
                {r.name} · the latest version
              </option>,
            ])}
            {text && !suggestions.rulesets.some((r) => text === r.slug || text === `${r.slug}@${r.version}`) && (
              <option value={text}>{text}</option>
            )}
          </select>
        );
      case "listref":
        return (
          <ChoiceSelect
            mono
            value={text}
            options={suggestions.lists}
            placeholder="Choose a list"
            onChange={(v) => set(def.field, v)}
          />
        );
      case "features": {
        const model = modelOfStep(step, suggestions.models);
        return (
          <FeaturesEditor
            stepId={step.id}
            value={raw}
            model={model && isUploaded(model) ? model : undefined}
            fields={fieldsForCondition}
            onChange={(v) => set(def.field, v)}
          />
        );
      }
      case "list":
        return (
          <input
            className="input mono"
            placeholder="one, two"
            value={Array.isArray(raw) ? raw.join(", ") : text}
            onChange={(e) => {
              const items = e.target.value.split(",").map((s) => s.trim());
              set(def.field, e.target.value.trim() ? items.filter((s, i) => s || i === items.length - 1) : undefined);
            }}
          />
        );
      case "number":
        return (
          <input
            className="input"
            inputMode="numeric"
            placeholder={def.placeholder}
            value={text}
            onChange={(e) => {
              const v = e.target.value.trim();
              set(def.field, v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : v);
            }}
          />
        );
      default:
        return (
          <input
            className={`input ${def.kind === "template" ? "mono" : ""}`}
            placeholder={def.placeholder}
            value={text}
            onChange={(e) => set(def.field, e.target.value)}
          />
        );
    }
  })();
  // A label gives a click to its first control: the builder, with its buttons, sits in a div.
  const Wrapper = def.kind === "condition" || def.kind === "questions" || def.kind === "features" ? "div" : "label";
  return (
    <Wrapper className="field">
      <span>{def.label}</span>
      {control}
      {def.hint && <small>{def.hint}</small>}
      {def.kind === "action" && suggestions.actions.length === 0 && <small>No actions yet. Make one first.</small>}
      {def.kind === "queue" && suggestions.queues.length === 0 && (
        <small>No queues yet. Make one in Queues first.</small>
      )}
      {def.kind === "model" && def.modelKind === "scoring" && !suggestions.models.some(isUploaded) && (
        <small>No scoring models yet. Train one with python -m kairos train, and it shows here.</small>
      )}
      {def.kind === "model" && def.modelKind === "scoring" && text && !text.includes("@") && (
        <small>The scores change when a new version is uploaded, with no change to this workflow.</small>
      )}
    </Wrapper>
  );
}

export function StepSettings({
  draft,
  step,
  problems,
  suggestions,
  onChange,
  onRename,
  onDuplicate,
  onDelete,
  onClose,
}: {
  draft: WorkflowDraft;
  step: WorkflowStep;
  problems: string[];
  suggestions: Suggestions;
  onChange: (step: WorkflowStep, tag: string) => void;
  /** Change the id. Returns why it cannot change, or null. */
  onRename: (id: string) => string | null;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const kind = kindOf(step.type);
  const [id, setId] = useState(step.id);
  const [idProblem, setIdProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    setId(step.id);
    setIdProblem(null);
  }, [step.id]);

  const set = (field: string, value: unknown) => {
    const next: WorkflowStep = { ...step };
    if (value === undefined || value === "") delete next[field];
    else next[field] = value;
    if (step.type === "ruleset" && field === "ruleset" && typeof value === "string") {
      const ruleset = suggestions.rulesets.find((r) => r.slug === value.split("@")[0]);
      const given = (next.input as Record<string, unknown> | undefined) ?? {};
      const source = (name: string) =>
        draft.trigger.type === "event"
          ? `{{ event.properties.${name} }}`
          : draft.trigger.type === "decision"
            ? `{{ trigger.properties.${name} }}`
            : `{{ trigger.${name} }}`;
      next.input = {
        ...Object.fromEntries((ruleset?.inputs ?? []).map((name) => [name, source(name)])),
        ...given,
      };
    }
    if (step.type === "score" && field === "model" && typeof value === "string") {
      const model = suggestions.models.find((m) => m.slug === slugOfRef(value));
      const suggested = model && isUploaded(model) ? (model.definition.suggested_features ?? {}) : {};
      next.features = { ...suggested, ...((next.features as Record<string, unknown> | undefined) ?? {}) };
    }
    if (field === "record") {
      // Fields of the other kind of record would be saved but never read: they go.
      const keep = new Set(fieldsOf(next).map((f) => f.field));
      for (const k of Object.keys(next)) if (!COMMON.has(k) && !keep.has(k)) delete next[k];
    }
    onChange(next, `${step.id}:${field}`);
  };

  const inLoop = ancestorsOf(draft.steps, step.id).some((s) => s.type === "loop");
  const earlier = readableBefore(draft.steps, step.id);
  const values = [
    "trigger",
    ...(draft.trigger.type === "event" ? ["event"] : []),
    ...(draft.trigger.type === "record" && typeof draft.trigger.record === "string" ? [draft.trigger.record] : []),
    ...(inLoop ? ["item", "index"] : []),
    ...earlier.map((s) => `steps.${s.id}.output`),
    "run.id",
  ];
  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
    setCopied(value);
  };
  const applyId = () => {
    if (id === step.id) return setIdProblem(null);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return setIdProblem("Letters, digits and _, not first a digit.");
    if (walk(draft.steps).some((e) => e.step.id === id)) return setIdProblem(`Another step has the id "${id}".`);
    setIdProblem(onRename(id));
  };

  return (
    <div className="wf-panel">
      <div className="wf-panel-head">
        <StepIcon icon={kind.icon} />
        <span className="wf-panel-title">
          <input
            className="wf-title-input"
            value={step.name}
            aria-label="Step name"
            onChange={(e) => onChange({ ...step, name: e.target.value }, `${step.id}:name`)}
          />
          <small>{kind.label}</small>
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="wf-panel-body">
        {problems.length > 0 && (
          <div className="wf-problems">
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        )}
        {draft.trigger.type === "decision" && checkAnswers(draft.steps).writesBefore.has(step.id) && (
          <div className="wf-problems note">
            This step writes before the answer. If a later step fails, decide() gets an error, and this write stays.
          </div>
        )}
        {fieldsOf(step).map((def) => (
          <Field
            key={def.field}
            def={def}
            step={step}
            set={set}
            suggestions={suggestions}
            conditionFields={conditionFields(
              {
                trigger: draft.trigger,
                earlier,
                inLoop,
                eventProperties: suggestions.eventProperties,
                entityTypes: suggestions.entityTypes,
              },
              "step",
            )}
          />
        ))}
        {(step.type === "condition" || step.type === "loop") && (
          <p className="muted wf-panel-note">
            {step.type === "condition"
              ? "Add the steps of each way on the canvas, under if and else."
              : "Add the steps to run for each item on the canvas, in the box."}
          </p>
        )}

        <div className="wf-values">
          <div className="wf-palette-title">Values this step can read</div>
          <p className="muted wf-panel-note">
            Use one as it is in an expression, or as {"{{ value }}"} in a text. Click to copy.
          </p>
          <div className="wf-value-list">
            {values.map((v) => (
              <button key={v} type="button" className="chip mono" onClick={() => copy(v)}>
                {copied === v ? "Copied" : v}
              </button>
            ))}
          </div>
        </div>

        {!["condition", "filter", "loop", "delay", "return", "answer"].includes(step.type) && (
          <div className="wf-field-row">
            <label className="field">
              <span>Attempts</span>
              <select
                className="input"
                value={String((step.retry as { attempts?: number } | undefined)?.attempts ?? "")}
                onChange={(e) => set("retry", e.target.value ? { attempts: Number(e.target.value) } : undefined)}
              >
                <option value="">3 (default)</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>When it fails</span>
              <select
                className="input"
                value={String(step.on_fail ?? "")}
                onChange={(e) => set("on_fail", e.target.value || undefined)}
              >
                <option value="">Stop the run</option>
                <option value="continue">Go on, with the error as output</option>
              </select>
            </label>
          </div>
        )}

        <details className="wf-advanced">
          <summary>Advanced</summary>
          <label className="field">
            <span>Id</span>
            <input
              className={`input mono ${idProblem ? "bad" : ""}`}
              value={id}
              onChange={(e) => setId(e.target.value)}
              onBlur={applyId}
              onKeyDown={(e) => e.key === "Enter" && applyId()}
            />
            <small>
              {idProblem ??
                `Later steps read this step as steps.${step.id}.output. A new id changes those references too.`}
            </small>
          </label>
        </details>
      </div>
      <div className="wf-panel-foot">
        <button type="button" className="btn" onClick={onDuplicate}>
          Duplicate
        </button>
        <button type="button" className="btn danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
