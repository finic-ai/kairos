import { experiments, workflows } from "../../api/index";
import { Empty, Failure, Loading } from "../../components/ui/states";
import { WorkflowPageTabs } from "../../components/workflows/WorkflowTabs";
import { useApi } from "../../hooks/useApi";
import {
  appliedBadge,
  experimentName,
  isPending,
  metricLabel,
  metricOf,
  POLL_MS,
  STATUS_TEXT,
  statusChip,
  testMetric,
  validMetric,
} from "../../lib/experiments";
import { actionName, stamp } from "../../lib/format";
import { metric } from "../../lib/models";
import { go, href } from "../../lib/route";
import type { Experiment } from "../../types/interfaces";

/** `/workflows/:name/experiments`: a workflow's experiments, newest first. */
export function WorkflowExperimentsPage({ name }: { name: string }) {
  const { data: workflow } = useApi(["workflow", name, "live"], () => workflows.get(name));
  const { data, error } = useApi(["workflow-experiments", name], () => experiments.list(name), {
    refetchInterval: (query) => (query.state.data?.experiments.some(isPending) ? POLL_MS : false),
  });
  if (error) return <Failure message={error.message} />;
  if (!data) return <Loading />;
  const list = data.experiments;

  const label = workflow ? actionName(workflow) : name;
  return (
    <>
      <WorkflowPageTabs name={name} label={label} current="experiments" />
      <header className="page-head">
        <div>
          <h1>Experiments on {label}</h1>
          <p className="lede">
            Each one trained several ways of scoring the workflow on its labeled runs, chose on newer runs and tested on
            the newest. Apply the variant you choose as the workflow's draft or next version.
          </p>
        </div>
      </header>
      {list.length === 0 ? (
        <div className="card">
          <Empty title="No experiments yet">
            <p style={{ margin: 0 }}>
              An agent designs an experiment through <a href={href("settings", "mcp")}>MCP</a> with{" "}
              <span className="mono">create_workflow_experiment</span>, or you send its variants to{" "}
              <span className="mono">POST /v1/workflows/{name}/experiments</span>. The server trains, validates and
              tests each one, and the results show here.
            </p>
            <small className="note" style={{ display: "block", marginTop: 10 }}>
              <a href="/docs/platform/models#experiments" target="_blank" rel="noreferrer">
                How experiments work
              </a>
            </small>
          </Empty>
        </div>
      ) : (
        <div className="stack">
          {list.map((e) => (
            <ExperimentCard key={e.id} experiment={e} />
          ))}
        </div>
      )}
    </>
  );
}

/** One experiment at a glance: each variant's model and accuracy, the best and the chosen. Click for the full page. */
function ExperimentCard({ experiment: e }: { experiment: Experiment }) {
  const name = e.workflow;
  const chosen = e.selected?.variant ?? e.applied?.variant ?? null;
  const m = metricOf(e);
  const results = e.results ?? [];
  // ROC-AUC bars start at 0.5, no better than chance, so close variants still look different.
  const floor = m === "roc_auc" ? 0.5 : 0;
  const top = Math.max(...results.map((r) => testMetric(r, m) ?? floor), floor + 0.01);
  const width = (v: number | null) => `${Math.max(0, ((v ?? floor) - floor) / (top - floor)) * 100}%`;
  const open = () => go("workflows", name, "experiments", e.id);
  return (
    <div className="card exp-card link" onClick={open}>
      <div className="exp-card-head">
        <div>
          <a href={href("workflows", name, "experiments", e.id)} onClick={(ev) => ev.stopPropagation()}>
            <b>{experimentName(e)}</b>
          </a>
          <div className="note">
            {stamp(e.created_at)} UTC{e.created_by ? ` · ${e.created_by}` : ""}
            {e.dataset &&
              ` · ${e.dataset.rows.toLocaleString()} runs, ${e.dataset.positives.toLocaleString()} positive · split ${e.dataset.split.train} / ${e.dataset.split.valid} / ${e.dataset.split.test}`}
          </div>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <span className={statusChip(e.status)} title={e.error ?? undefined}>
            {STATUS_TEXT[e.status]}
          </span>
          {e.applied && (
            <span className={e.applied.published ? "chip ok" : "chip accent"}>{appliedBadge(e.applied)}</span>
          )}
        </div>
      </div>
      {e.status === "failed" && e.error && <div className="note exp-card-error">{e.error}</div>}
      {results.length > 0 ? (
        <table className="exp-variants">
          <colgroup>
            <col style={{ width: "56%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "26%" }} />
          </colgroup>
          <thead>
            <tr>
              <th>Variant</th>
              <th style={num}>Validation {metricLabel(m)}</th>
              <th>Test {metricLabel(m)}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => {
              const test = testMetric(r, m);
              return (
                <tr key={r.key} className={r.key === chosen ? "chosen" : undefined}>
                  <td className="wrap">
                    <span className="muted mono">{i + 1}</span> {r.name}
                    {r.key === e.best && (
                      <span className="chip" title="Best on validation">
                        ★ Best
                      </span>
                    )}
                    {r.key === chosen && <span className="chip accent">Chosen</span>}
                    {r.problems.length > 0 && (
                      <span className="chip warn" title={r.problems.join("\n")}>
                        Problem
                      </span>
                    )}
                  </td>
                  <td className="mono" style={num}>
                    {metric(validMetric(r, m))}
                  </td>
                  <td>
                    <div className="exp-bar">
                      <span style={{ width: width(test) }} />
                      <b className="mono">{metric(test)}</b>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        isPending(e) && (
          <div className="note">Training, validating and testing {e.config.variants.length} variants…</div>
        )
      )}
    </div>
  );
}

const num = { textAlign: "right" as const };
