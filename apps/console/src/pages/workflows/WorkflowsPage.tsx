import { useState } from "react";
import { Empty, Failure, Loading } from "../../components/ui/states";
import { useWorkflows } from "../../hooks/useApi";
import { actionName } from "../../lib/format";
import { go, href } from "../../lib/route";
import { countSteps, triggerSummary } from "../../lib/workflows";

export function WorkflowsPage() {
  const [archived, setArchived] = useState(false);
  const { data, error } = useWorkflows(archived);
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Workflows</h1>
          <p className="lede">
            Work that runs on its own: one trigger and a list of steps, run in the background when an event arrives or
            when you start it.
          </p>
        </div>
        <a className="btn primary" href={href("workflows", "new")}>
          New workflow
        </a>
      </header>
      <div className="filters">
        <div className="seg">
          <button className={archived ? "" : "on"} onClick={() => setArchived(false)}>
            All
          </button>
          <button className={archived ? "on" : ""} onClick={() => setArchived(true)}>
            Archived
          </button>
        </div>
      </div>
      {error && <Failure message={error.message} />}
      {!data ? (
        <Loading />
      ) : data.workflows.length === 0 ? (
        <div className="card">
          {archived ? (
            <Empty title="No archived workflows">An archived workflow is kept here, with its runs and versions.</Empty>
          ) : (
            <Empty title="No workflows yet">Build the first piece of work Kairos should run on its own.</Empty>
          )}
        </div>
      ) : (
        <div className="card table-wrap">
          <div className="table-head">
            {data.workflows.length} {data.workflows.length === 1 ? "workflow" : "workflows"}
          </div>
          <table>
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Starts</th>
                <th style={{ textAlign: "right" }}>Steps</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Version</th>
              </tr>
            </thead>
            <tbody>
              {data.workflows.map((w) => (
                <tr key={w.name} className="link big" onClick={() => go("workflows", w.name)}>
                  <td className="wrap action-cell">
                    <a className="type-name" href={href("workflows", w.name)} onClick={(e) => e.stopPropagation()}>
                      {actionName(w)}
                    </a>
                    <span className="mono muted action-key">{w.name}</span>
                  </td>
                  <td>{triggerSummary(w)}</td>
                  <td className="mono muted" style={{ textAlign: "right" }}>
                    {countSteps(w.steps)}
                  </td>
                  <td>
                    {w.status === "draft" ? (
                      <span className="chip warn">Draft</span>
                    ) : (
                      <>
                        {w.status === "archived" ? (
                          <span className="chip">Archived</span>
                        ) : w.enabled ? (
                          <span className="chip ok">Active</span>
                        ) : (
                          <span className="chip">Paused</span>
                        )}{" "}
                        {w.draft && <span className="chip warn">Draft</span>}{" "}
                        {w.failing_since && <span className="chip warn">Failing</span>}
                      </>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {w.version > 0 ? (
                      <span className="chip accent">v{w.version}</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
