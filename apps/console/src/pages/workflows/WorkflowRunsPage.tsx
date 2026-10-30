import { useState } from "react";
import { workflows } from "../../api/index";
import { Empty, Failure, Loading } from "../../components/ui/states";
import { WorkflowPageTabs } from "../../components/workflows/WorkflowTabs";
import { useApi } from "../../hooks/useApi";
import { actionName, durationText, stamp } from "../../lib/format";
import { go, href } from "../../lib/route";
import { RUN_OPEN, RUN_STATUS_LABEL } from "../../lib/workflows";
import type { WorkflowRun } from "../../types/interfaces";

const PAGE = 50;

const chipFor = (status: string) =>
  status === "done"
    ? "chip ok"
    : status === "failed" || status === "cancelled"
      ? "chip warn"
      : RUN_OPEN.includes(status)
        ? "chip accent"
        : "chip";

function startedBy(run: WorkflowRun): string {
  const t = run.trigger as { event?: { type?: string; id?: string }; record?: string; on?: string };
  if (run.test) return "Test";
  if (t.record) return `${t.record[0]!.toUpperCase()}${t.record.slice(1)} ${t.on ?? ""}`.trim();
  if (t.event?.type) return `${t.event.type} event`;
  return "Manual";
}

const took = (run: WorkflowRun) => {
  if (!run.started || !run.finished) return "";
  const ms = Date.parse(run.finished) - Date.parse(run.started);
  return ms < 1000 ? `${Math.max(0, ms)} ms` : durationText(ms);
};

/** `/workflows/:name/runs`: a workflow's runs, newest first. */
export function WorkflowRunsPage({ name }: { name: string }) {
  const [limit, setLimit] = useState(PAGE);
  const { data: workflow } = useApi(["workflow", name, "live"], () => workflows.get(name));
  const { data, error } = useApi(["workflow-runs", name, limit], () => workflows.runs(name, limit), {
    refetchInterval: 5000,
  });
  if (error) return <Failure message={error.message} />;
  if (!data) return <Loading />;
  const runs = data.runs;

  const label = workflow ? actionName(workflow) : name;
  return (
    <>
      <WorkflowPageTabs name={name} label={label} current="runs" />
      <header className="page-head">
        <div>
          <h1>Runs of {label}</h1>
          <p className="lede">Newest first. A run opens on the canvas it ran, with what each step did.</p>
        </div>
      </header>
      {runs.length === 0 ? (
        <div className="card">
          <Empty title="No runs yet">
            The workflow runs when its trigger starts it, or when you run it from the builder.
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Started by</th>
                <th>Version</th>
                <th>When</th>
                <th style={{ textAlign: "right" }}>Took</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="link" onClick={() => go("workflows", name, "runs", run.id)}>
                  <td>
                    <a
                      className="mono"
                      href={href("workflows", name, "runs", run.id)}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {run.id}
                    </a>
                  </td>
                  <td>
                    <span className={chipFor(run.status)}>{RUN_STATUS_LABEL[run.status] ?? run.status}</span>
                  </td>
                  <td>{startedBy(run)}</td>
                  <td className="mono muted">{run.test ? "draft" : `v${run.workflow.split("@").at(-1)}`}</td>
                  <td className="mono muted">{stamp(run.created)} UTC</td>
                  <td className="mono muted" style={{ textAlign: "right" }}>
                    {took(run)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.length === limit && limit < 500 && (
            <div className="list-more">
              <span className="muted">{runs.length} shown</span>
              <button type="button" className="btn" onClick={() => setLimit(Math.min(500, limit + PAGE))}>
                Show more
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
