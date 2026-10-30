import type { CaseCategory } from "@kairos/core";
import { useState, type ReactNode } from "react";
import type { ResolveBody } from "../../api/queues";
import { Modal } from "../../components/ui/Modal";
import { CATEGORY_LABEL } from "../../lib/queues";

const DECISION_CATEGORIES: CaseCategory[] = ["approved", "blocked"];
const LABEL_CATEGORIES: CaseCategory[] = ["confirmed_fraud", "false_positive"];

export function ResolveModal({
  title,
  decisions,
  label,
  onResolve,
  onClose,
}: {
  title: string;
  /** The text after "Also resolve", for the outcome the decisions get. */
  decisions: (target: "approve" | "block") => ReactNode;
  /** The text after "Label", for the label the entity gets. */
  label: (tag: string) => ReactNode;
  onResolve: (body: ResolveBody) => Promise<unknown>;
  onClose: () => void;
}) {
  const [category, setCategory] = useState<CaseCategory>("approved");
  const [note, setNote] = useState("");
  const [applyTo, setApplyTo] = useState(true);
  const [labelTarget, setLabelTarget] = useState(true);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const target = category === "approved" ? "approve" : "block";
  const decides = DECISION_CATEGORIES.includes(category);
  const labels = LABEL_CATEGORIES.includes(category);
  const resolve = async () => {
    setSaving(true);
    setProblem(null);
    try {
      await onResolve({
        category,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(decides ? { apply_to_decisions: applyTo } : {}),
        ...(labels ? { label_target: labelTarget } : {}),
      });
    } catch (e) {
      setProblem((e as Error).message);
      setSaving(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body">
        {problem && <div className="banner">{problem}</div>}
        <label className="field">
          <span>Outcome</span>
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value as CaseCategory)}>
            {Object.entries(CATEGORY_LABEL).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Note</span>
          <textarea
            className="input"
            rows={3}
            maxLength={2000}
            placeholder="Why (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {decides && (
          <label className="check" style={{ display: "block", margin: "6px 0" }}>
            <input type="checkbox" checked={applyTo} onChange={(e) => setApplyTo(e.target.checked)} /> Also resolve{" "}
            {decisions(target)}
          </label>
        )}
        {labels && (
          <label className="check" style={{ display: "block", margin: "6px 0" }}>
            <input type="checkbox" checked={labelTarget} onChange={(e) => setLabelTarget(e.target.checked)} /> Label{" "}
            {label(category === "confirmed_fraud" ? "fraud_confirmed" : "cleared")}
          </label>
        )}
        <p className="note">
          {decides
            ? "A decision's resolution is what your system is told, by decision.updated. Without it, the decisions stay as the model left them."
            : "A label is what later decisions read about this entity."}
        </p>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving} onClick={resolve}>
            {saving ? "Resolving…" : "Resolve"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
