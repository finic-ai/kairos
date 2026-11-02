import { useState } from "react";
import { workflows } from "../../api/index";
import { InTopbar } from "../../components/shell/InTopbar";
import { KV } from "../../components/ui/KV";
import { Failure, Loading } from "../../components/ui/states";
import { MatchedTerms, RunSteps } from "../../components/workflows/RunSteps";
import { WorkflowCanvas } from "../../components/workflows/WorkflowCanvas";
import { useApi } from "../../hooks/useApi";
import { useWorkflowRun } from "../../hooks/useWorkflowRun";
import { durationText, stamp } from "../../lib/format";
import { RUN_OPEN, RUN_STATUS_LABEL } from "../../lib/workflows";
import { findStep } from "../../lib/workflowTree";

const chipFor = (status: string) =>
  status === "done"
    ? "chip ok"
    : status === "failed" || status === "cancelled"
      ? "chip warn"
      : RUN_OPEN.includes(status)
        ? "chip accent"
        : "chip";

/** `/workflows/:name/runs/:id`: one run, on the canvas it ran, with what each step did. */
export function WorkflowRunPage({ id }: { id: string }) {
  const { run, marks, error, refetch } = useWorkflowRun(id);
  const label = run?.workflow ?? "@";
  const name = label.slice(0, label.lastIndexOf("@"));
  const version = Number(label.split("@").at(-1));
  const { data: saved } = useApi(["workflow", name, version], () => workflows.get(name, version), {
    enabled: !!run && !run.definition && version > 0,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  if (error) return <Failure message={error.message} />;
  if (!run) return <Loading />;

  const definition = run.definition ?? saved;
  const chosen = selected && selected !== "trigger" && definition ? findStep(definition.steps, selected) : undefined;
  const ms = run.started && run.finished ? Date.parse(run.finished) - Date.parse(run.started) : null;
  const took = ms === null ? null : ms < 1000 ? `${Math.max(0, ms)} ms` : durationText(ms);

  const cancel = async () => {
    setBusy(true);
    setCancelError(null);
    try {
      await workflows.cancel(run.id);
      await refetch();
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wf-builder">
      {RUN_OPEN.includes(run.status) && (
        <InTopbar slot="topbar-slot">
          <button type="button" className="btn danger" disabled={busy} onClick={() => void cancel()}>
            {busy ? "Cancelling…" : "Cancel the run"}
          </button>
        </InTopbar>
      )}
      <div className={`wf-stage ${selected ? "with-panel" : ""}`}>
        <div className="wf-state">
          <span className={chipFor(run.status)}>{RUN_STATUS_LABEL[run.status] ?? run.status}</span>
          <span className="chip">{run.test ? "Test run" : `Version ${version}`}</span>
          <span className="wf-state-note">
            {stamp(run.created)} UTC{took ? ` · took ${took}` : ""}
          </span>
          {run.output !== undefined && run.output !== null && (
            <button type="button" className="btn wf-state-btn" onClick={() => setSelected("output")}>
              Output
            </button>
          )}
        </div>
        {(run.error || cancelError) && <div className="wf-notice bad top">{cancelError ?? run.error}</div>}
        {definition ? (
          <WorkflowCanvas definition={definition} marks={marks} selected={selected} onSelect={setSelected} />
        ) : (
          <Loading />
        )}
        {selected && (
          <aside className="wf-side">
            <div className="wf-panel">
              <div className="wf-panel-head">
                <span className="wf-panel-title">
                  <b>
                    {selected === "trigger"
                      ? "What started it"
                      : selected === "output"
                        ? "What the run gave"
                        : (chosen?.name ?? selected)}
                  </b>
                  <small>{selected === "trigger" ? "Trigger" : selected === "output" ? "Output" : "Step"}</small>
                </span>
                <button type="button" className="icon-btn" onClick={() => setSelected(null)} aria-label="Close">
                  ×
                </button>
              </div>
              <div className="wf-panel-body">
                {selected === "trigger" ? (
                  <>
                    <MatchedTerms terms={run.trigger_terms} />
                    <KV data={run.trigger} />
                  </>
                ) : selected === "output" ? (
                  <pre className="wf-json">{JSON.stringify(run.output, null, 2)}</pre>
                ) : (
                  <RunSteps steps={run.steps.filter((s) => s.id === selected)} empty="This step did not run." />
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
