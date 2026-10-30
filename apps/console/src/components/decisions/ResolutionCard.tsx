import { useState } from "react";
import { api } from "../../api/index";
import type { DecisionRecord, Resolution } from "../../types/interfaces";
import { Pill } from "./Outcome";
import { Card } from "../ui/Card";
import { stamp } from "../../lib/format";
import { OUTCOME_LABEL } from "../../lib/outcomes";

/**
 * A person's decision on this decision: approve or block, with a note. The model's decision stays
 * as it was; the final outcome changes, and webhooks that want decision.updated are told.
 */
export function ResolutionCard({ d, onResolved }: { d: DecisionRecord; onResolved: () => void }) {
  const [note, setNote] = useState("");
  const [changing, setChanging] = useState(false);
  const [saving, setSaving] = useState<Resolution["outcome"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const r = d.resolution;
  const pending = d.decision.decision === "review" || d.decision.decision === "step_up";

  const resolve = (outcome: Resolution["outcome"]) => {
    setSaving(outcome);
    setError(null);
    api
      .resolve(d.id, outcome, note)
      .then(
        () => (setChanging(false), setNote(""), onResolved()),
        (e: Error) => setError(e.message),
      )
      .finally(() => setSaving(null));
  };

  if (r && !changing)
    return (
      <Card title="Resolution" className="o-resolution">
        <div className="resolution">
          <Pill outcome={r.outcome} />
          <span className="by">
            by <b>{r.by}</b>
            <small className="mono">{stamp(r.at)} UTC</small>
          </span>
        </div>
        {r.note && <p className="resolution-note">{r.note}</p>}
        <button className="btn ghost" onClick={() => setChanging(true)}>
          Change
        </button>
      </Card>
    );
  return (
    <Card title={r ? "Change the resolution" : pending ? "Resolve this review" : "Override"} className="o-resolution">
      {error && (
        <div className="banner" style={{ margin: "0 0 10px" }}>
          {error}
        </div>
      )}
      <textarea
        className="input"
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Why (optional)"
        maxLength={2000}
      />
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn good" disabled={!!saving} onClick={() => resolve("approve")}>
          {saving === "approve" ? "Approving…" : "Approve"}
        </button>
        <button className="btn danger" disabled={!!saving} onClick={() => resolve("block")}>
          {saving === "block" ? "Blocking…" : "Block"}
        </button>
        {r && (
          <button className="btn ghost" onClick={() => (setChanging(false), setError(null))}>
            Cancel
          </button>
        )}
      </div>
      <p className="note" style={{ margin: "10px 0 0" }}>
        {pending
          ? "The model sent this to a person."
          : `The ${d.metadata?.decision_workflow ? "workflow" : "model"} decided ${OUTCOME_LABEL[d.decision.decision].toLowerCase()}. Use this only to override it.`}{" "}
        Its decision stays on record; webhooks get decision.updated.
      </p>
    </Card>
  );
}
