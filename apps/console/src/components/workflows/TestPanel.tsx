import { useState } from "react";
import { href } from "../../lib/route";
import { RUN_OPEN, RUN_STATUS_LABEL } from "../../lib/workflows";
import { walk } from "../../lib/workflowTree";
import type { WorkflowDraft, WorkflowRun } from "../../types/interfaces";
import { Failure } from "../ui/states";
import { RunSteps } from "./RunSteps";

const WRITES = new Set(["http", "decide", "record.create", "record.update", "case.create", "case.resolve"]);

/** A sample input for the trigger, so a first test has the right shape. */
export function sampleInput(trigger: WorkflowDraft["trigger"]): string {
  if (trigger.type === "record") {
    const sample: Record<string, unknown> =
      trigger.record === "decision"
        ? {
            decision: {
              id: "kdec_test_1",
              action: trigger.action || "action",
              subject: { type: "user", id: "user_1" },
            },
          }
        : trigger.record === "event"
          ? { event: { id: "evt_test_1", type: "event_type", entities: { user: "user_1" }, properties: {} } }
          : { entity: { type: trigger.entity || "user", id: "user_1", properties: {} } };
    return JSON.stringify({ record: trigger.record, on: trigger.on, ...sample }, null, 2);
  }
  if (trigger.type === "event")
    return JSON.stringify(
      {
        event: {
          id: "evt_test_1",
          type: trigger.event || "event_type",
          ts: new Date().toISOString(),
          entities: { user: "user_1" },
          properties: {},
        },
      },
      null,
      2,
    );
  return "{}";
}

export function TestPanel({
  draft,
  run,
  busy,
  error,
  onRun,
  onClear,
  onClose,
}: {
  draft: WorkflowDraft;
  run: WorkflowRun | undefined;
  busy: boolean;
  error: string | null;
  onRun: (input: Record<string, unknown>, live: string[]) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState(() => sampleInput(draft.trigger));
  const [live, setLive] = useState<Set<string>>(new Set());
  const [inputProblem, setInputProblem] = useState<string | null>(null);
  const writes = walk(draft.steps).filter((e) => WRITES.has(e.step.type));

  const start = () => {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      setInputProblem(null);
      onRun(parsed as Record<string, unknown>, [...live]);
    } catch {
      setInputProblem("The input must be a JSON object.");
    }
  };

  return (
    <div className="wf-panel">
      <div className="wf-panel-head">
        <span className="wf-panel-title">
          <b>Test run</b>
          <small>The workflow as it is on the canvas, saved or not</small>
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="wf-panel-body">
        <label className="field">
          <span>Input</span>
          <textarea
            className={`input mono ${inputProblem ? "bad" : ""}`}
            rows={8}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <small>
            {inputProblem ??
              (draft.trigger.type === "event" ? "Steps read it as event and as trigger." : "Steps read it as trigger.")}
          </small>
        </label>

        {writes.length > 0 && (
          <div className="field">
            <span>Do for real</span>
            <small>
              Search and get steps read real data. Steps that write only show what they would do, unless they are chosen
              here.
            </small>
            {writes.map(({ step }) => (
              <label key={step.id} className="wf-check">
                <input
                  type="checkbox"
                  checked={live.has(step.id)}
                  onChange={(e) => {
                    const next = new Set(live);
                    if (e.target.checked) next.add(step.id);
                    else next.delete(step.id);
                    setLive(next);
                  }}
                />
                <span>
                  <b>{step.name}</b>
                  <small className="mono">{step.id}</small>
                </span>
              </label>
            ))}
          </div>
        )}

        {error && <Failure message={error} />}
        <div className="row">
          <button type="button" className="btn primary" disabled={busy} onClick={start}>
            {busy ? "Starting…" : run ? "Run the test again" : "Run the test"}
          </button>
          {run && (
            <button type="button" className="btn" onClick={onClear}>
              Clear the result
            </button>
          )}
        </div>

        {run && (
          <div className="wf-test-result">
            <div className="row wrap">
              <b>{RUN_STATUS_LABEL[run.status] ?? run.status}</b>
              {RUN_OPEN.includes(run.status) && <span className="muted">Updates as it runs…</span>}
              <a className="linkish" href={href("workflows", draft.name || "draft", "runs", run.id)}>
                Open the run
              </a>
            </div>
            {run.error && <div className="wh-failed">{run.error}</div>}
            <RunSteps steps={run.steps} />
          </div>
        )}
      </div>
    </div>
  );
}
