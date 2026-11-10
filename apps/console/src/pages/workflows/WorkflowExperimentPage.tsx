import { Fragment, useState } from "react";
import { experiments, workflows } from "../../api/index";
import { Card } from "../../components/ui/Card";
import { KV } from "../../components/ui/KV";
import { Modal } from "../../components/ui/Modal";
import { Failure, Loading } from "../../components/ui/states";
import { BacktestSection, backtestProgressText, isBacktest } from "../../components/workflows/Backtest";
import { WorkflowCanvas } from "../../components/workflows/WorkflowCanvas";
import { useApi } from "../../hooks/useApi";
import {
  appliedBadge,
  baselineOf,
  coefficientsOf,
  experimentName,
  featuresOf,
  gainOf,
  isPending,
  metricLabel,
  metricOf,
  periodOf,
  trainedOn,
  POLL_MS,
  rateText,
  resultOf,
  STATUS_TEXT,
  statusChip,
  structureOf,
  testMetric,
  validMetric,
} from "../../lib/experiments";
import { actionName, stamp } from "../../lib/format";
import { metric, slugOfRef } from "../../lib/models";
import { href } from "../../lib/route";
import type {
  Experiment,
  ExperimentMetric,
  ExperimentResult,
  WorkflowDefinition,
  WorkflowStep,
} from "../../types/interfaces";

const num = { textAlign: "right", whiteSpace: "nowrap" } as const;

/** `/workflows/:name/experiments/:id`: one experiment's variants, how each did, the choice, and applying one. */
export function WorkflowExperimentPage({ name, id }: { name: string; id: string }) {
  const { data: workflow } = useApi(["workflow", name, "live"], () => workflows.get(name));
  const {
    data: experiment,
    error,
    refetch,
  } = useApi(["workflow-experiment", id], () => experiments.get(id), {
    refetchInterval: (query) => (query.state.data && isPending(query.state.data) ? POLL_MS : false),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [applying, setApplying] = useState<ExperimentResult | null>(null);
  const [renaming, setRenaming] = useState<ExperimentResult | null>(null);
  const [applied, setApplied] = useState<{ variant: string; workflow: WorkflowDefinition; published: boolean } | null>(
    null,
  );
  if (error) return <Failure message={error.message} />;
  if (!experiment) return <Loading />;

  const { results, selected } = experiment;
  const dataset = trainedOn(experiment);
  const m = metricOf(experiment);
  const baselineKey = baselineOf(experiment);
  const baseline = resultOf(experiment, baselineKey);
  const best = resultOf(experiment, experiment.best);
  const chosen = resultOf(experiment, selected?.variant);
  const title = workflow ? actionName(workflow) : name;
  const nameOf = (key: string) => resultOf(experiment, key)?.name ?? key;

  return (
    <>
      <a className="crumb" href={href("workflows", name, "experiments")}>
        ← Experiments
      </a>
      <header className="page-head">
        <div>
          <h1>{experimentName(experiment)}</h1>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <span className={statusChip(experiment.status)} title={experiment.error ?? undefined}>
              {STATUS_TEXT[experiment.status]}
            </span>
            {experiment.base_version !== null && <span className="chip">From version {experiment.base_version}</span>}
            {experiment.applied && (
              <span className={experiment.applied.published ? "chip ok" : "chip accent"}>
                {appliedBadge(experiment.applied)}
              </span>
            )}
            <span className="chip">{experiment.id}</span>
          </div>
          {experiment.config.hypothesis && <p className="lede">{experiment.config.hypothesis}</p>}
          <p className="note" style={{ margin: "8px 0 0" }}>
            On {title}, {stamp(experiment.created_at)} UTC{experiment.created_by ? ` by ${experiment.created_by}` : ""}.
            {experiment.config.variants.length > 0 &&
              "Each variant was trained on the oldest runs, compared on the next ones, and tested on the newest."}
          </p>
        </div>
        <a className="btn" href={href("workflows", name)}>
          Open the builder
        </a>
      </header>
      {isPending(experiment) && (
        <div className="banner info">
          {isBacktest(experiment)
            ? `${backtestProgressText(experiment)} This page updates as it goes.`
            : experiment.status === "queued"
              ? `Queued: the server will train ${experiment.config.variants.length} variants. This page updates when they are done.`
              : `Training and testing ${experiment.config.variants.length} variants. This page updates when they are done.`}
        </div>
      )}
      {experiment.status === "failed" && (
        <div className="banner">The experiment failed: {experiment.error ?? "no reason was recorded."}</div>
      )}
      {applied && (
        <div className="banner ok">
          {applied.published
            ? `${nameOf(applied.variant)} is now version ${applied.workflow.version} of ${title}. `
            : `${nameOf(applied.variant)} is saved as the draft of ${title}. `}
          <a href={href("workflows", applied.workflow.name)}>Open the builder</a>
        </div>
      )}
      {renaming && (
        <RenameModal
          experiment={experiment}
          variant={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            void refetch();
          }}
        />
      )}
      {applying && (
        <ApplyModal
          experiment={experiment}
          variant={applying}
          onClose={() => setApplying(null)}
          onApplied={(workflow, published) => {
            setApplied({ variant: applying.key, workflow, published });
            setApplying(null);
            void refetch();
          }}
        />
      )}

      <BacktestSection experiment={experiment} workflow={name} />

      {dataset && (
        <div className="summary-row">
          <div className="card">
            <span>Labeled runs</span>
            <b>{dataset.rows.toLocaleString()}</b>
            <small>
              {dataset.positives.toLocaleString()} positive
              {dataset.rows > 0 ? ` (${((dataset.positives / dataset.rows) * 100).toFixed(1)}%)` : ""}
            </small>
          </div>
          <div className="card">
            <span>Period</span>
            <b>{periodOf(dataset)}</b>
            <small>
              Labels <span className="mono">{dataset.labels.join(", ") || "—"}</span> within{" "}
              <span className="mono">{dataset.window}</span> of the run.
            </small>
          </div>
          <div className="card">
            <span>Split by time</span>
            <b>
              {dataset.split.train.toLocaleString()} / {dataset.split.valid.toLocaleString()} /{" "}
              {dataset.split.test.toLocaleString()}
            </b>
            <small>Train, validation and test rows, oldest to newest.</small>
          </div>
          <div className="card">
            <span>Selection</span>
            <b>Best on validation: {metricLabel(m)}</b>
            <small>
              {best ? (
                <>
                  Best: <b style={{ font: "inherit", color: "var(--ink-2)" }}>{best.name}</b>.{" "}
                </>
              ) : null}
              Gains are against {baseline?.name ?? baselineKey}.
            </small>
          </div>
        </div>
      )}

      {selected && (
        <section className="card pad" style={{ marginBottom: 20, borderColor: "var(--accent)" }}>
          <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
            <span className="chip accent">Chosen</span>
            <b style={{ fontWeight: 600, fontSize: 15 }}>{chosen?.name ?? selected.variant}</b>
            {selected.variant !== experiment.best && best && (
              <span className="note">The best on validation was {best.name}.</span>
            )}
          </div>
          {selected.reason ? (
            <p className="quote" style={{ borderLeftColor: "var(--accent)", whiteSpace: "pre-wrap" }}>
              {selected.reason}
            </p>
          ) : (
            <p className="note" style={{ margin: 0 }}>
              No reason was given.
            </p>
          )}
          <p className="note" style={{ margin: "8px 0 0" }}>
            {selected.by ? `By ${selected.by}, ` : ""}
            {stamp(selected.at)} UTC.
          </p>
        </section>
      )}

      {results && results.length > 0 && (
        <div className="stack">
          <Card title={`Test ${metricLabel(m)}`}>
            <MetricBars experiment={experiment} results={results} m={m} />
          </Card>
          <Card title={`Variants · ${results.length}`} className="flush-table">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Variant</th>
                    <th>Structure</th>
                    <th style={num}>Valid {metricLabel(m)}</th>
                    <th style={num}>Test ROC-AUC</th>
                    <th style={num}>Test PR-AUC</th>
                    <th style={num} title="Test ROC-AUC over the baseline, with a 95% bootstrap interval">
                      Gain (95% CI)
                    </th>
                    <th style={num} title="Precision / recall at the review threshold, on the test rows">
                      At review P / R
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {results.map((v) => {
                    const gain = gainOf(v, baselineKey);
                    const isApplied = experiment.applied?.variant === v.key;
                    const expanded = open === v.key;
                    const blocked = v.problems.length > 0;
                    return (
                      <Fragment key={v.key}>
                        <tr className="link" onClick={() => setOpen(expanded ? null : v.key)} aria-expanded={expanded}>
                          <td className="wrap" style={{ minWidth: 200, maxWidth: 320 }}>
                            <div className="row wrap" style={{ gap: 6 }}>
                              <b style={{ fontWeight: 600 }}>{v.name}</b>
                              {v.key === experiment.best && <span className="chip">Best on validation</span>}
                              {v.key === selected?.variant && <span className="chip accent">Chosen</span>}
                              {isApplied && experiment.applied && (
                                <span className="chip ok">{appliedBadge(experiment.applied)}</span>
                              )}
                              {blocked && (
                                <span className="chip warn" title={v.problems.join("\n")}>
                                  {v.problems.length === 1 ? "1 problem" : `${v.problems.length} problems`}
                                </span>
                              )}
                            </div>
                            {v.description && (
                              <div className="note" style={{ whiteSpace: "normal" }}>
                                {v.description}
                              </div>
                            )}
                          </td>
                          <td className="muted wrap" style={{ minWidth: 140, maxWidth: 220 }}>
                            {structureOf(v.model)}
                          </td>
                          <td className="mono muted" style={num}>
                            {metric(validMetric(v, m))}
                          </td>
                          <td className="mono" style={num}>
                            {metric(v.metrics.test.roc_auc)}
                          </td>
                          <td className="mono muted" style={num}>
                            {metric(v.metrics.test.pr_auc)}
                          </td>
                          <td
                            className={gain.better ? "mono" : "mono muted"}
                            style={{ ...num, ...(gain.better ? { color: "var(--approve-text)" } : {}) }}
                          >
                            {gain.text}
                          </td>
                          <td className="mono muted" style={num}>
                            {rateText(v.metrics.at_review.precision, v.metrics.at_review.recall)}
                          </td>
                          <td style={num}>
                            <button
                              type="button"
                              className="btn ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenaming(v);
                              }}
                            >
                              Rename
                            </button>{" "}
                            {!isApplied && experiment.status === "done" && (
                              <button
                                type="button"
                                className="btn"
                                disabled={blocked}
                                title={blocked ? `Cannot apply: ${v.problems.join("; ")}` : undefined}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setApplying(v);
                                }}
                              >
                                Apply
                              </button>
                            )}
                          </td>
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={8} style={{ background: "var(--surface-2)" }}>
                              <VariantDetail variant={v} trigger={workflow?.trigger} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

/** ROC-AUC bars start at 0.5, a model that guesses: the differences between variants are small. */
function MetricBars({
  experiment,
  results,
  m,
}: {
  experiment: Experiment;
  results: ExperimentResult[];
  m: ExperimentMetric;
}) {
  const floor = m === "roc_auc" ? 0.5 : 0;
  const chosenKey = experiment.selected?.variant ?? null;
  return (
    <>
      <div className="hbars">
        {results.map((v) => {
          const value = testMetric(v, m);
          const share = value === null ? 0 : Math.max(0, (value - floor) / (1 - floor));
          const chosen = v.key === chosenKey;
          const best = v.key === experiment.best;
          return (
            <div key={v.key} title={`${v.name}: ${metric(value)}${best ? " · best on validation" : ""}`}>
              <span className="name" style={chosen ? { fontWeight: 600 } : undefined}>
                {best ? "★ " : ""}
                {v.name}
              </span>
              <span className="track">
                <span
                  style={{
                    width: `${Math.max(share * 100, 0.5)}%`,
                    background: chosen ? "var(--accent)" : "var(--ink-3)",
                    opacity: chosen ? 1 : 0.45,
                  }}
                />
              </span>
              <span className="value">{metric(value)}</span>
            </div>
          );
        })}
      </div>
      <p className="note" style={{ margin: "12px 0 0" }}>
        {m === "roc_auc" ? "From 0.5, no better than chance, to 1. " : "From 0 to 1. "}
        {chosenKey ? "The chosen variant is highlighted; " : ""}★ marks the best on validation.
      </p>
    </>
  );
}

function VariantDetail({ variant, trigger }: { variant: ExperimentResult; trigger?: WorkflowDefinition["trigger"] }) {
  const { metrics, model, notes } = variant;
  const features = featuresOf(model);
  const steps = (variant.steps ?? []) as WorkflowStep[];
  const coefficients = coefficientsOf(notes);
  const settings: Record<string, unknown> = {
    ...(model.type === "gbdt" ? model.params : model.type === "stacked" ? model.base.params : {}),
    ...((model.type === "logistic" || model.type === "stacked") && model.l2 !== undefined ? { l2: model.l2 } : {}),
    ...(typeof notes.trees === "number" ? { Trees: notes.trees } : {}),
    ...(typeof notes.fitted_on === "number" ? { "Fitted on": `${notes.fitted_on.toLocaleString()} rows` } : {}),
    ...(typeof notes.base_fitted_on === "number"
      ? { "Trees fitted on": `${notes.base_fitted_on.toLocaleString()} rows` }
      : {}),
    ...(typeof notes.layer_fitted_on === "number"
      ? { "Layer fitted on": `${notes.layer_fitted_on.toLocaleString()} rows` }
      : {}),
  };
  const models = (["base", "model"] as const).flatMap((role) => {
    const ref = variant.models[role];
    return ref ? [{ role, ref }] : [];
  });
  return (
    <div className="stack" style={{ gap: 16, padding: "6px 0" }}>
      {variant.problems.length > 0 && (
        <div className="banner" style={{ margin: 0 }}>
          Its steps cannot be saved: {variant.problems.join("; ")}
        </div>
      )}
      <div className="row wrap" style={{ alignItems: "flex-start", gap: 32 }}>
        <div className="stack" style={{ gap: 6, maxWidth: 360 }}>
          {features.trees.length > 0 && (
            <>
              <span className="note">{model.type === "stacked" ? "Trees read" : "Fields"}</span>
              <ChipList items={features.trees} />
            </>
          )}
          {features.layer.length > 0 && (
            <>
              <span className="note">
                {model.type === "stacked"
                  ? "Stacked with the trees' score"
                  : model.type === "probability"
                    ? "Scores with"
                    : "Fields"}
              </span>
              <ChipList items={features.layer} />
            </>
          )}
          {variant.drop_steps.length > 0 && (
            <>
              <span className="note">Drops the steps</span>
              <ChipList items={variant.drop_steps} />
            </>
          )}
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="note">Models</span>
          {models.length === 0 ? (
            <span className="muted">None trained</span>
          ) : (
            models.map(({ role, ref }) => {
              const version = ref.split("@")[1];
              return (
                <span key={ref}>
                  <a
                    className="mono"
                    href={`${href("settings", "models", slugOfRef(ref))}${version ? `?version=${version}` : ""}`}
                  >
                    {ref}
                  </a>
                  {role === "base" && <span className="note"> · base</span>}
                </span>
              );
            })
          )}
          {Object.keys(settings).length > 0 && (
            <div style={{ marginTop: 8, minWidth: 200 }}>
              <KV data={settings} />
            </div>
          )}
        </div>
        {coefficients.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="note">Coefficients</span>
            <table style={{ width: "auto" }}>
              <tbody>
                {coefficients.map(([feature, value]) => (
                  <tr key={feature}>
                    <td className="mono">{feature}</td>
                    <td className="mono muted" style={num}>
                      {metric(value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ minWidth: 260 }}>
          <KV
            data={{
              "Review at": metric(metrics.thresholds.review),
              "Flagged for review": metrics.at_review.flagged,
              "Review precision / recall": rateText(metrics.at_review.precision, metrics.at_review.recall),
              "Block at": metric(metrics.thresholds.block),
              Blocked: metrics.at_block.flagged,
              "Block precision / recall": rateText(metrics.at_block.precision, metrics.at_block.recall),
            }}
          />
        </div>
      </div>
      {steps.length > 0 ? (
        <div className="wf-preview">
          <WorkflowCanvas definition={{ trigger: trigger ?? { type: "manual" }, steps }} />
        </div>
      ) : (
        <span className="note">The steps are not recorded.</span>
      )}
    </div>
  );
}

const ChipList = ({ items }: { items: string[] }) =>
  items.length === 0 ? (
    <span className="muted">—</span>
  ) : (
    <div className="chips">
      {items.map((item) => (
        <span key={item} className="chip">
          {item}
        </span>
      ))}
    </div>
  );

function ApplyModal({
  experiment,
  variant,
  onClose,
  onApplied,
}: {
  experiment: Experiment;
  variant: ExperimentResult;
  onClose: () => void;
  onApplied: (workflow: WorkflowDefinition, published: boolean) => void;
}) {
  const [busy, setBusy] = useState<"draft" | "publish" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const apply = async (publish: boolean) => {
    setBusy(publish ? "publish" : "draft");
    setProblem(null);
    try {
      const text = reason.trim();
      const { workflow } = await experiments.apply(experiment.id, {
        variant: variant.key,
        ...(text ? { reason: text } : {}),
        publish,
      });
      onApplied(workflow, publish);
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(null);
    }
  };
  return (
    <Modal title={`Apply ${variant.name}`} onClose={() => !busy && onClose()}>
      <div className="modal-body">
        {problem && <div className="banner">{problem}</div>}
        <p className="note" style={{ marginTop: 0 }}>
          The workflow's steps become this variant's steps. Save them as the draft to look at them in the builder first,
          or publish them: new runs then use them.
        </p>
        <label className="field">
          <span>Why this variant (optional)</span>
          <textarea
            className="input"
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="The gain's interval is above zero, and it needs one ask step fewer."
            disabled={!!busy}
          />
        </label>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={() => void apply(false)} disabled={!!busy}>
            {busy === "draft" ? "Saving…" : "Save as draft"}
          </button>
          <button type="button" className="btn primary" onClick={() => void apply(true)} disabled={!!busy}>
            {busy === "publish" ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RenameModal({
  experiment,
  variant,
  onClose,
  onRenamed,
}: {
  experiment: Experiment;
  variant: ExperimentResult;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const [name, setName] = useState(variant.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await experiments.rename(experiment.id, { variants: { [variant.key]: name.trim() } });
      onRenamed();
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Rename the variant" onClose={() => !busy && onClose()}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {problem && <div className="banner">{problem}</div>}
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim() || name.trim() === variant.name}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
