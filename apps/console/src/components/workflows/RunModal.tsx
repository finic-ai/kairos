import { useState } from "react";
import { workflows } from "../../api/index";
import { Modal } from "../ui/Modal";
import { Failure } from "../ui/states";
import { checkAnswers, RUN_STATUS_LABEL } from "../../lib/workflows";
import type { WorkflowInput, WorkflowRun, WorkflowStep } from "../../types/interfaces";

const ENDED = ["done", "filtered", "failed", "cancelled"];

/** The value of one input from its form field. Throws with a message a person can act on. */
function valueOf(input: WorkflowInput, raw: string): unknown {
  const label = input.label || input.name;
  switch (input.type) {
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${label} must be a number.`);
      return n;
    }
    case "boolean":
      return raw === "true";
    case "list":
      return raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    case "object": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`${label} is not valid JSON.`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(`${label} must be a JSON object.`);
      return parsed;
    }
    default:
      return raw;
  }
}

/**
 * Run the live version of a workflow. With inputs, a form asks for each; without, a JSON object.
 * "Run" opens the run; "Run and wait" shows its output here, when the run has no delay.
 */
export function RunModal({
  name,
  title,
  version,
  inputs,
  steps,
  onClose,
  onStarted,
}: {
  name: string;
  title: string;
  version: number;
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
  onClose: () => void;
  onStarted: (run: WorkflowRun) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      inputs.map((i) => [
        i.name,
        i.default === undefined ? "" : typeof i.default === "object" ? JSON.stringify(i.default) : String(i.default),
      ]),
    ),
  );
  const [json, setJson] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WorkflowRun | null>(null);
  const delay = checkAnswers(steps, { waits: true }).delay;

  const input = (): Record<string, unknown> => {
    if (inputs.length === 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new Error("The input is not valid JSON.");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("The input must be a JSON object.");
      return parsed as Record<string, unknown>;
    }
    const out: Record<string, unknown> = {};
    for (const i of inputs) {
      const raw = values[i.name] ?? "";
      if (raw === "") {
        if (i.required) throw new Error(`${i.label || i.name} is required.`);
        continue;
      }
      out[i.name] = valueOf(i, raw);
    }
    return out;
  };

  const run = async (wait: boolean) => {
    setError(null);
    setResult(null);
    let given: Record<string, unknown>;
    try {
      given = input();
    } catch (e) {
      return setError((e as Error).message);
    }
    setBusy(true);
    try {
      const started = await workflows.start(name, given, { wait });
      if (wait) setResult(started);
      else onStarted(started);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Run ${title}`} onClose={onClose}>
      <div className="modal-body">
        {inputs.length === 0 ? (
          <label className="field">
            <span>Input (JSON)</span>
            <textarea className="input mono" rows={6} value={json} onChange={(e) => setJson(e.target.value)} />
            <small>The steps read it as trigger. Add inputs to the trigger to get a form here.</small>
          </label>
        ) : (
          inputs.map((i) => (
            <label key={i.name} className="field">
              <span>
                {i.label || i.name}
                {i.required ? " *" : ""}
              </span>
              {i.type === "boolean" ? (
                <select
                  className="input"
                  value={values[i.name] ?? ""}
                  onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}
                >
                  <option value="">Not given</option>
                  <option value="true">True</option>
                  <option value="false">False</option>
                </select>
              ) : i.type === "object" ? (
                <textarea
                  className="input mono"
                  rows={4}
                  placeholder="{}"
                  value={values[i.name] ?? ""}
                  onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}
                />
              ) : (
                <input
                  className={`input ${i.type === "entity" ? "mono" : ""}`}
                  type={i.type === "number" ? "number" : "text"}
                  placeholder={i.type === "entity" ? `${i.entity ?? "entity"} id` : i.type === "list" ? "a, b, c" : ""}
                  value={values[i.name] ?? ""}
                  onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}
                />
              )}
              <small>
                {i.description || ""}
                {i.description ? " " : ""}
                <span className="mono">trigger.{i.name}</span>
                {i.type === "list" ? ", separated by commas" : ""}
              </small>
            </label>
          ))
        )}
        <small className="muted">The live version runs: version {version}.</small>
        {error && <Failure message={error} />}
        {result && (
          <div className="wf-run-result">
            <div className="row wrap">
              <span className={`wf-mark ${result.status}`}>{RUN_STATUS_LABEL[result.status] ?? result.status}</span>
              {!ENDED.includes(result.status) && (
                <span className="muted">The time was up, or a step waits for a retry. The run goes on.</span>
              )}
            </div>
            {result.error && <div className="wh-failed">{result.error}</div>}
            {ENDED.includes(result.status) && (
              <pre className="wf-json">{JSON.stringify(result.output ?? null, null, 2)}</pre>
            )}
            <button type="button" className="btn ghost" onClick={() => onStarted(result)}>
              Open the run
            </button>
          </div>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !!delay}
            title={
              delay
                ? `The step "${delay.name}" is a delay before the answer: a caller cannot wait for this run.`
                : "Run it now, and show its output here"
            }
            onClick={() => void run(true)}
          >
            {busy ? "Running…" : "Run and wait"}
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void run(false)}>
            Run
          </button>
        </div>
      </div>
    </Modal>
  );
}
