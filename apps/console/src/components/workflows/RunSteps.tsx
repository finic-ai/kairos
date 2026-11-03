import { durationText, stamp } from "../../lib/format";
import { RUN_STATUS_LABEL } from "../../lib/workflows";
import { href } from "../../lib/route";
import type { ListTerm, WorkflowRunStep } from "../../types/interfaces";

/** The list items that an `inList` matched, each with a link to its list. */
export function MatchedTerms({ terms }: { terms?: ListTerm[] }) {
  if (!terms?.length) return null;
  return (
    <div className="wf-run-terms">
      <span className="muted">Matched in a list:</span>{" "}
      {terms.map((t, i) => (
        <span key={`${t.list}:${t.item}`}>
          {i > 0 && ", "}
          <span className="mono">{t.item}</span>{" "}
          <a href={href("settings", "lists", t.list)} className="muted">
            ({t.list})
          </a>
        </span>
      ))}
    </div>
  );
}

const took = (s: WorkflowRunStep) => {
  if (!s.started || !s.finished) return null;
  const ms = Date.parse(s.finished) - Date.parse(s.started);
  return ms < 1000 ? `${Math.max(0, ms)} ms` : durationText(ms);
};

export function RunSteps({ steps, empty = "No step has run yet." }: { steps: WorkflowRunStep[]; empty?: string }) {
  if (steps.length === 0) return <p className="muted wf-panel-note">{empty}</p>;
  return (
    <div className="wf-run-steps">
      {steps.map((s) => {
        const output = s.output as { test?: boolean; would?: unknown } | undefined;
        return (
          <div key={s.path} className={`wf-run-step ${s.status}`}>
            <div className="row wrap">
              <b>{s.name}</b>
              <span className={`wf-mark ${s.status}`}>{RUN_STATUS_LABEL[s.status] ?? s.status}</span>
              {output?.test && <span className="chip warn">Shown, not done</span>}
            </div>
            <div className="muted mono wf-run-meta">
              {s.path}
              {s.attempt && s.attempt > 1 ? ` · attempt ${s.attempt}` : ""}
              {took(s) ? ` · ${took(s)}` : ""}
              {s.wake ? ` · until ${stamp(s.wake)} UTC` : ""}
            </div>
            <MatchedTerms terms={s.terms} />
            {s.error ? (
              <div className="wh-failed">{s.error}</div>
            ) : (
              s.output !== undefined && <pre className="wf-json">{JSON.stringify(s.output, null, 2)}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
