import { useState, type ReactNode } from "react";
import { OUTCOME_LABEL, RULESET_INPUT_TYPES, sampleInput } from "../../lib/rulesets";
import type {
  RulesetDefinition,
  RulesetOutcome,
  RulesetResult,
  RulesetRule,
  RulesetTestRun,
  WorkflowInput,
} from "../../types/interfaces";
import { ConditionBuilder } from "../workflows/ConditionBuilder";
import { InputsEditor } from "../workflows/InputsEditor";
import { JsonField } from "../workflows/StepSettings";
import { OutcomeMark } from "./RulesetCanvas";

function Panel({
  icon,
  title,
  label,
  problems = [],
  foot,
  onClose,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  label: string;
  problems?: string[];
  foot?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="wf-panel">
      <div className="wf-panel-head">
        {icon}
        <span className="wf-panel-title">
          {title}
          <small>{label}</small>
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
        {children}
      </div>
      {foot && <div className="wf-panel-foot">{foot}</div>}
    </div>
  );
}

function OutcomeField({ value, onChange }: { value: RulesetOutcome; onChange: (o: RulesetOutcome) => void }) {
  return (
    <div className="field">
      <span>Then</span>
      <div className="seg rs-seg">
        {(["approve", "reject"] as const).map((o) => (
          <button key={o} type="button" className={value === o ? `on ${o}` : ""} onClick={() => onChange(o)}>
            {OUTCOME_LABEL[o]}
          </button>
        ))}
      </div>
    </div>
  );
}

function ResponseField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  return (
    <label className="field">
      <span>Response</span>
      <JsonField value={value} onChange={onChange} placeholder={'{ "reason": "new_device" }'} />
      <small>Any JSON. It comes back with the outcome. Leave it empty for none.</small>
    </label>
  );
}

export function RuleSettings({
  rule,
  index,
  count,
  inputs,
  lists,
  problems,
  onChange,
  onRename,
  onMove,
  onDuplicate,
  onDelete,
  onClose,
}: {
  rule: RulesetRule;
  index: number;
  count: number;
  inputs: string[];
  lists: string[];
  problems: string[];
  onChange: (rule: RulesetRule, tag?: string) => void;
  onRename: (id: string) => string | null;
  onMove: (by: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [id, setId] = useState(rule.id);
  const [idProblem, setIdProblem] = useState<string | null>(null);
  const applyId = () => setIdProblem(id === rule.id ? null : onRename(id));
  return (
    <Panel
      icon={<OutcomeMark outcome={rule.outcome} />}
      title={
        <input
          className="wf-title-input"
          value={rule.name}
          aria-label="Rule name"
          onChange={(e) => onChange({ ...rule, name: e.target.value }, `${rule.id}:name`)}
        />
      }
      label={`Rule ${index + 1} of ${count}`}
      problems={problems}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn" disabled={index === 0} onClick={() => onMove(-1)}>
            Move up
          </button>
          <button type="button" className="btn" disabled={index === count - 1} onClick={() => onMove(1)}>
            Move down
          </button>
          <button type="button" className="btn" onClick={onDuplicate}>
            Duplicate
          </button>
          <button type="button" className="btn danger" onClick={onDelete}>
            Delete
          </button>
        </>
      }
    >
      <div className="field">
        <span>If</span>
        <ConditionBuilder
          value={rule.when}
          fields={inputs.map((name) => `input.${name}`)}
          lists={lists}
          placeholder="input.amount >= 1000"
          onChange={(when) => onChange({ ...rule, when }, `${rule.id}:when`)}
        />
        <small>A rule that reads an input that is not there does not match.</small>
      </div>
      <OutcomeField value={rule.outcome} onChange={(outcome) => onChange({ ...rule, outcome })} />
      <ResponseField
        value={rule.response}
        onChange={(response) => {
          const { response: _old, ...rest } = rule;
          onChange(response === undefined ? rest : { ...rest, response }, `${rule.id}:response`);
        }}
      />
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
          <small>{idProblem ?? "The result names the rule that matched by this id. Tests refer to it too."}</small>
        </label>
      </details>
    </Panel>
  );
}

export function StartSettings({
  slug,
  isNew,
  description,
  inputs,
  settings,
  problems,
  onSlug,
  onDescription,
  onInputs,
  onSettings,
  onClose,
}: {
  slug: string;
  isNew: boolean;
  description: string;
  inputs: WorkflowInput[];
  settings: Record<string, unknown>;
  problems: string[];
  onSlug: (slug: string) => void;
  onDescription: (text: string) => void;
  onInputs: (inputs: WorkflowInput[]) => void;
  onSettings: (settings: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  return (
    <Panel
      icon={
        <span className="rs-mark start" aria-hidden="true">
          <svg viewBox="0 0 20 20">
            <path d="M4 10h9M10 6l4 4-4 4" />
          </svg>
        </span>
      }
      title={<b className="rs-panel-title">Start</b>}
      label="What the ruleset reads"
      problems={problems}
      onClose={onClose}
    >
      <label className="field">
        <span>Slug</span>
        <input className="input mono" value={slug} disabled={!isNew} onChange={(e) => onSlug(e.target.value.trim())} />
        <small>
          {isNew
            ? "Workflows use the ruleset by its slug. It does not change after the first save."
            : "Workflows use the ruleset by its slug."}
        </small>
      </label>
      <label className="field">
        <span>Description</span>
        <textarea
          className="input"
          rows={2}
          value={description}
          placeholder="What these rules are for"
          onChange={(e) => onDescription(e.target.value)}
        />
      </label>
      <InputsEditor
        inputs={inputs}
        entityTypes={[]}
        types={RULESET_INPUT_TYPES}
        labelHint="Label"
        empty="None. The rules can read any field of the input."
        note={
          <>
            Rules read each input as <span className="mono">input.name</span>. An evaluation without a required input is
            refused.
          </>
        }
        onChange={onInputs}
      />
      <details className="wf-advanced">
        <summary>Settings</summary>
        <label className="field">
          <span>Settings</span>
          <JsonField
            value={settings}
            onChange={(v) =>
              onSettings(v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
            }
            placeholder="{}"
          />
          <small>JSON that Kairos keeps with the ruleset. No rule reads it, so a change makes no new version.</small>
        </label>
      </details>
    </Panel>
  );
}

export function DefaultSettings({
  fallback,
  problems,
  onChange,
  onClose,
}: {
  fallback: RulesetDefinition["default"];
  problems: string[];
  onChange: (fallback: RulesetDefinition["default"]) => void;
  onClose: () => void;
}) {
  return (
    <Panel
      icon={<OutcomeMark outcome={fallback.outcome} />}
      title={<b className="rs-panel-title">No rule matches</b>}
      label="The outcome when no rule matches"
      problems={problems}
      onClose={onClose}
    >
      <OutcomeField value={fallback.outcome} onChange={(outcome) => onChange({ ...fallback, outcome })} />
      <ResponseField
        value={fallback.response}
        onChange={(response) =>
          onChange(response === undefined ? { outcome: fallback.outcome } : { ...fallback, response })
        }
      />
    </Panel>
  );
}

function ResultView({ result, rules }: { result: RulesetResult; rules: RulesetRule[] }) {
  const rule = rules.find((r) => r.id === result.rule);
  return (
    <div className="rs-result">
      <div className="rs-result-head">
        <span className={`rs-chip outcome ${result.outcome}`}>
          <OutcomeMark outcome={result.outcome} />
          {OUTCOME_LABEL[result.outcome]}
        </span>
        <span className="muted">
          {result.matched ? `from rule ${rules.indexOf(rule!) + 1}, "${rule?.name ?? result.rule}"` : "no rule matched"}
        </span>
      </div>
      {result.response !== null && <pre className="rs-pre">{JSON.stringify(result.response, null, 2)}</pre>}
      {result.terms.length > 0 && (
        <small className="muted">
          Matched in a list: {result.terms.map((t) => `${t.item} (${t.list})`).join(", ")}
        </small>
      )}
      {result.missing.length > 0 && (
        <small className="muted">
          Not run, an input is missing:{" "}
          {result.missing.map((id) => rules.find((r) => r.id === id)?.name ?? id).join(", ")}
        </small>
      )}
    </div>
  );
}

export function TestPanel({
  definition,
  busy,
  run,
  problems,
  onRun,
  onTests,
  onClose,
}: {
  definition: RulesetDefinition;
  busy: boolean;
  run: RulesetTestRun | null;
  problems: string[];
  onRun: (input?: Record<string, unknown>) => void;
  onTests: (tests: RulesetDefinition["tests"]) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState<unknown>(() => sampleInput(definition));
  const valid = !!input && typeof input === "object" && !Array.isArray(input);
  const result = run?.result;
  const tests = definition.tests;
  const setTest = (i: number, change: Partial<RulesetDefinition["tests"][number]>) =>
    onTests(tests.map((t, j) => (j === i ? { ...t, ...change } : t)));
  return (
    <Panel
      icon={
        <span className="rs-mark start" aria-hidden="true">
          <svg viewBox="0 0 20 20">
            <path d="M7 5v10l8-5z" />
          </svg>
        </span>
      }
      title={<b className="rs-panel-title">Test</b>}
      label="Run the rules as they are now, saved or not"
      problems={problems}
      onClose={onClose}
    >
      <label className="field">
        <span>Input</span>
        <JsonField value={input} onChange={setInput} placeholder={'{ "amount": 1200 }'} />
      </label>
      <div className="row">
        <button
          type="button"
          className="btn primary"
          disabled={busy || !valid}
          onClick={() => onRun(input as Record<string, unknown>)}
        >
          {busy ? "Running…" : "Run"}
        </button>
        {result && (
          <button
            type="button"
            className="btn"
            onClick={() =>
              onTests([
                ...tests,
                {
                  name: `Test ${tests.length + 1}`,
                  input: input as Record<string, unknown>,
                  outcome: result.outcome,
                  rule: result.rule,
                },
              ])
            }
          >
            Keep as a test
          </button>
        )}
      </div>
      {run?.error && <div className="wf-problems">{run.error}</div>}
      {run && run.problems.length > 0 && (
        <div className="wf-problems">
          {run.problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}
      {result && <ResultView result={result} rules={definition.rules} />}

      <div className="rs-tests">
        <div className="rs-tests-head">
          <b>Tests</b>
          <small className="muted">Each test must pass before a publish.</small>
          <button type="button" className="btn" disabled={busy || tests.length === 0} onClick={() => onRun()}>
            Run the tests
          </button>
        </div>
        {tests.length === 0 && <small className="muted">No tests yet. Run an input, then keep it as a test.</small>}
        {tests.map((test, i) => {
          const ran = run?.tests[i];
          return (
            <details key={i} className={`rs-test ${ran ? (ran.passed ? "passed" : "failed") : ""}`}>
              <summary>
                <span className="rs-test-mark">{ran ? (ran.passed ? "✓" : "✕") : "·"}</span>
                <span className="rs-test-name">{test.name}</span>
                <span className={`rs-outcome ${test.outcome}`}>{OUTCOME_LABEL[test.outcome]}</span>
              </summary>
              <label className="field">
                <span>Name</span>
                <input className="input" value={test.name} onChange={(e) => setTest(i, { name: e.target.value })} />
              </label>
              <label className="field">
                <span>Input</span>
                <JsonField
                  value={test.input}
                  onChange={(v) =>
                    v &&
                    typeof v === "object" &&
                    !Array.isArray(v) &&
                    setTest(i, { input: v as Record<string, unknown> })
                  }
                />
              </label>
              <div className="wf-field-row">
                <label className="field">
                  <span>Expect</span>
                  <select
                    className="input"
                    value={test.outcome}
                    onChange={(e) => setTest(i, { outcome: e.target.value as RulesetOutcome })}
                  >
                    <option value="approve">Approve</option>
                    <option value="reject">Reject</option>
                  </select>
                </label>
                <label className="field">
                  <span>From</span>
                  <select
                    className="input"
                    value={test.rule === undefined ? "*" : test.rule === null ? "" : test.rule}
                    onChange={(e) => {
                      const { rule: _rule, ...rest } = test;
                      const v = e.target.value;
                      onTests(tests.map((t, j) => (j === i ? (v === "*" ? rest : { ...rest, rule: v || null }) : t)));
                    }}
                  >
                    <option value="*">Any rule</option>
                    <option value="">No rule: the default</option>
                    {definition.rules.map((r, n) => (
                      <option key={r.id} value={r.id}>
                        {n + 1}. {r.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {ran && !ran.passed && (
                <small className="wh-failed">
                  {ran.error ??
                    (ran.result &&
                      `Gave ${OUTCOME_LABEL[ran.result.outcome].toLowerCase()} from ${
                        ran.result.rule
                          ? `"${definition.rules.find((r) => r.id === ran.result!.rule)?.name ?? ran.result.rule}"`
                          : "the default"
                      }.`)}
                </small>
              )}
              <button type="button" className="btn danger" onClick={() => onTests(tests.filter((_, j) => j !== i))}>
                Delete the test
              </button>
            </details>
          );
        })}
      </div>
    </Panel>
  );
}
