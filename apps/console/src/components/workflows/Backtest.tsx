import { useState } from "react";
import { experiments } from "../../api/index";
import { Modal } from "../ui/Modal";
import { stamp } from "../../lib/format";
import { href } from "../../lib/route";
import type { BacktestReport, Experiment } from "../../types/interfaces";

const OUTCOMES = ["approve", "step_up", "review", "block"] as const;
const OUTCOME_TEXT: Record<string, string> = {
  approve: "Approve",
  step_up: "Step-up",
  review: "Review",
  block: "Block",
  failed: "Failed",
  none: "No answer",
};
const CHIP: Record<string, string> = { approve: "ok", step_up: "accent", review: "review", block: "warn" };
const COLOR: Record<string, string> = {
  approve: "var(--approve)",
  step_up: "var(--step_up)",
  review: "var(--review)",
  block: "var(--block)",
};

const PERIODS: [string, number | null][] = [
  ["Last 30 days", 30],
  ["Last 60 days", 60],
  ["Last 90 days", 90],
  ["Last 180 days", 180],
  ["Last year", 365],
  ["All history", null],
];

const percent = (share: number) => `${(share * 100).toFixed(share > 0 && share < 0.01 ? 2 : 1)}%`;
const ranOnText = (ranOn: "draft" | number) => (ranOn === "draft" ? "the draft" : `version ${ranOn}`);

export const isBacktest = (experiment: Pick<Experiment, "config">) => Boolean(experiment.config.backtest);

/** Starts a backtest of the workflow: its draft if it has one, else its live version. */
export function BacktestModal({
  workflow,
  hasDraft,
  onClose,
  onStarted,
}: {
  workflow: string;
  hasDraft: boolean;
  onClose: () => void;
  onStarted: (experiment: Experiment) => void;
}) {
  const [days, setDays] = useState<number | null>(90);
  const [labels, setLabels] = useState("chargeback");
  const [window, setWindow] = useState("90d");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const from = days === null ? undefined : new Date(Date.now() - days * 86_400_000).toISOString();
      const made = await experiments.backtest(workflow, {
        name: `Backtest, ${days === null ? "all history" : `last ${days} days`}`,
        labels: labels
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean),
        window: window.trim(),
        backtest: from ? { from } : {},
      });
      onStarted(made);
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Backtest" onClose={() => !busy && onClose()}>
      <div className="modal-body">
        {problem && <div className="banner">{problem}</div>}
        <p className="note" style={{ marginTop: 0 }}>
          Runs {hasDraft ? "the draft" : "the live version"} of the workflow on each past request of its action, as of
          the moment it came. Nothing is decided, and steps that act, such as HTTP requests and record changes, only say
          what they would do. Each model step asks the model once for each request.
        </p>
        <label className="field">
          <span>Requests from</span>
          <select
            className="input"
            value={days ?? ""}
            onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)}
            disabled={busy}
          >
            {PERIODS.map(([text, d]) => (
              <option key={text} value={d ?? ""}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Bad outcomes (labels, separated by commas)</span>
          <input className="input mono" value={labels} onChange={(e) => setLabels(e.target.value)} disabled={busy} />
        </label>
        <label className="field">
          <span>Counted within</span>
          <input className="input mono" value={window} onChange={(e) => setWindow(e.target.value)} disabled={busy} />
          <small className="note">After each request, such as 90d.</small>
        </label>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void start()}
            disabled={busy || !labels.trim() || !window.trim()}
          >
            {busy ? "Starting…" : "Start backtest"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function backtestProgressText(experiment: Experiment): string | null {
  const p = experiment.dataset?.backtest_progress;
  if (!isBacktest(experiment)) return null;
  if (!p) return experiment.status === "queued" ? "Queued: the backtest starts soon." : "Replaying past requests…";
  return `Replaying past requests through ${ranOnText(p.ran_on)}: ${(p.runs + p.skipped).toLocaleString()} of ${p.requests.toLocaleString()}.`;
}

/** One bar, the share of each outcome. */
export function OutcomeBar({ report }: { report: BacktestReport }) {
  const total = Object.values(report.outcomes).reduce((a, b) => a + b, 0) || 1;
  const keys = [...OUTCOMES, "failed", "none"].filter((k) => report.outcomes[k]);
  return (
    <div>
      <div className="row" style={{ height: 10, borderRadius: 5, overflow: "hidden", gap: 0 }}>
        {keys.map((k) => (
          <span
            key={k}
            title={`${OUTCOME_TEXT[k] ?? k}: ${report.outcomes[k]}`}
            style={{
              width: `${(report.outcomes[k]! / total) * 100}%`,
              height: "100%",
              background: COLOR[k] ?? "var(--line)",
            }}
          />
        ))}
      </div>
      <div className="row wrap note" style={{ gap: 12, marginTop: 6 }}>
        {keys.map((k) => (
          <span key={k}>
            {OUTCOME_TEXT[k] ?? k} <b>{report.outcomes[k]!.toLocaleString()}</b> ({percent(report.outcomes[k]! / total)}
            )
          </span>
        ))}
      </div>
    </div>
  );
}

const reasonText = (r: unknown) =>
  typeof r === "string" ? r : typeof (r as { code?: unknown })?.code === "string" ? (r as { code: string }).code : "";

/** What the workflow would have decided over the backtest, and how that compares with the labels. */
export function BacktestSection({ experiment, workflow }: { experiment: Experiment; workflow: string }) {
  const report = experiment.dataset?.backtest;
  if (!report) return null;
  const labels = experiment.config.labels.join(", ");
  const anyLabelled = Object.values(report.labelled).some((o) => o.labelled > 0);
  return (
    <section className="card pad" style={{ marginBottom: 20 }}>
      <h2 style={{ marginTop: 0 }}>Backtest</h2>
      <p className="note" style={{ marginTop: 0 }}>
        {ranOnText(report.ran_on)[0]!.toUpperCase() + ranOnText(report.ran_on).slice(1)} ran on{" "}
        <b>{report.runs.toLocaleString()}</b> past requests of <span className="mono">{report.action}</span>
        {report.skipped ? `, and skipped ${report.skipped.toLocaleString()} that name no subject` : ""}. Nothing was
        decided or changed.
      </p>
      <OutcomeBar report={report} />

      {experiment.dataset?.not_trained && (
        <div className="banner info" style={{ marginTop: 16 }}>
          No variant was trained: {experiment.dataset.not_trained}
        </div>
      )}

      <h3>Against the labels</h3>
      {anyLabelled ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Outcome</th>
                <th style={num}>Requests</th>
                <th style={num}>Labeled {labels}</th>
                <th style={num}>Share</th>
                <th style={num}>Too recent to know</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(report.labelled).map(([outcome, o]) => (
                <tr key={outcome}>
                  <td>{OUTCOME_TEXT[outcome] ?? outcome}</td>
                  <td className="mono" style={num}>
                    {o.runs.toLocaleString()}
                  </td>
                  <td className="mono" style={num}>
                    {o.labelled.toLocaleString()}
                  </td>
                  <td className="mono" style={num}>
                    {o.runs - o.unknown > 0 ? percent(o.labelled / (o.runs - o.unknown)) : "—"}
                  </td>
                  <td className="mono" style={num}>
                    {o.unknown.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="note">
          None of these requests' subjects got <span className="mono">{labels}</span> within{" "}
          <span className="mono">{experiment.config.window}</span>, so there is nothing yet to say which outcomes were
          right.
        </p>
      )}

      {report.reasons.length > 0 && (
        <>
          <h3>Top reasons</h3>
          <div className="row wrap" style={{ gap: 6 }}>
            {report.reasons.map((r) => (
              <span key={r.code} className="chip">
                <span className="mono">{r.code}</span> · {r.runs.toLocaleString()}
              </span>
            ))}
          </div>
        </>
      )}

      <h3>Flagged</h3>
      {report.flagged.length === 0 ? (
        <p className="note">The workflow would have sent no request to review or blocked any.</p>
      ) : (
        <>
          <p className="note" style={{ marginTop: 0 }}>
            The requests it would have sent to review or blocked, highest risk first
            {report.flagged.length === 100 ? " (the first 100)" : ""}.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Subject</th>
                  <th>Outcome</th>
                  <th style={num}>Risk</th>
                  <th>Reasons</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {report.flagged.map((f) => (
                  <tr key={f.run_id}>
                    <td className="mono">{stamp(f.ts)}</td>
                    <td>
                      <a className="mono linkish" href={href("entities", f.subject.type, f.subject.id)}>
                        {f.subject.id}
                      </a>
                    </td>
                    <td>
                      <span className={`chip ${CHIP[f.outcome] ?? ""}`}>{OUTCOME_TEXT[f.outcome] ?? f.outcome}</span>
                    </td>
                    <td className="mono" style={num}>
                      {f.risk_score ?? "—"}
                    </td>
                    <td className="wrap">
                      {f.reasons
                        .map(reasonText)
                        .filter(Boolean)
                        .map((r) => (
                          <span key={r} className="chip mono">
                            {r}
                          </span>
                        ))}
                    </td>
                    <td>
                      <a href={href("workflows", workflow, "runs", f.run_id)}>Run</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {report.errors.length > 0 && (
        <>
          <h3>Failed runs</h3>
          <ul className="note">
            {report.errors.map((e) => (
              <li key={e.run_id}>
                <a href={href("workflows", workflow, "runs", e.run_id)}>{e.run_id}</a>: {e.error}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const num = { textAlign: "right" as const };
