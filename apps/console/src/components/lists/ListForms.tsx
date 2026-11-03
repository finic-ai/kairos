import { useState, type FormEvent } from "react";
import { lists } from "../../api/index";
import { MATCH_LABEL, MATCHES } from "../../lib/lists";
import type { ListDetail, ListMatch } from "../../types/interfaces";
import { Modal } from "../ui/Modal";

/** A match and a case. With `inherit`, an item can leave either one to the list. */
export function MatchFields({
  match,
  caseSensitive,
  inherit,
  onChange,
}: {
  match: ListMatch | null;
  caseSensitive: boolean | null;
  inherit?: { match: ListMatch; case_sensitive: boolean };
  onChange: (match: ListMatch | null, caseSensitive: boolean | null) => void;
}) {
  const shown = match ?? inherit?.match ?? "exact";
  return (
    <div className="field">
      <div className="wf-field-row">
        <label className="field">
          <span>Match</span>
          <select
            className="input"
            value={match ?? ""}
            onChange={(e) => onChange((e.target.value || null) as ListMatch | null, caseSensitive)}
          >
            {inherit && <option value="">The list's: {MATCH_LABEL[inherit.match].label}</option>}
            {MATCHES.map((m) => (
              <option key={m} value={m}>
                {MATCH_LABEL[m].label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Case</span>
          <select
            className="input"
            value={caseSensitive === null ? "" : caseSensitive ? "yes" : "no"}
            onChange={(e) => onChange(match, e.target.value === "" ? null : e.target.value === "yes")}
          >
            {inherit && <option value="">The list's: {inherit.case_sensitive ? "case sensitive" : "any case"}</option>}
            <option value="no">Any case</option>
            <option value="yes">Case sensitive</option>
          </select>
        </label>
      </div>
      <small>{MATCH_LABEL[shown].note}</small>
    </div>
  );
}

export function EditListModal({ list, onClose }: { list: ListDetail; onClose: () => void }) {
  const [name, setName] = useState(list.name);
  const [description, setDescription] = useState(list.description ?? "");
  const [match, setMatch] = useState<ListMatch>(list.match);
  const [caseSensitive, setCaseSensitive] = useState(list.case_sensitive);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const changed = match !== list.match || caseSensitive !== list.case_sensitive;
  const affected = list.items.filter(
    (i) =>
      (match !== list.match && i.match === undefined) ||
      (caseSensitive !== list.case_sensitive && i.case_sensitive === undefined),
  ).length;
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await lists.save(list.slug, {
        name: name.trim(),
        description: description.trim() || null,
        match,
        case_sensitive: caseSensitive,
      });
      onClose();
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Edit ${list.slug}`} onClose={() => !busy && onClose()}>
      <form className="modal-body" onSubmit={save}>
        {problem && <div className="banner">{problem}</div>}
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            autoFocus
            disabled={busy}
          />
        </label>
        <label className="field">
          <span>Description</span>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
          />
        </label>
        <MatchFields
          match={match}
          caseSensitive={caseSensitive}
          onChange={(m, c) => (setMatch(m ?? "exact"), setCaseSensitive(c ?? false))}
        />
        {changed && (
          <p className="note" style={{ margin: 0 }}>
            Changes {affected.toLocaleString()} {affected === 1 ? "item" : "items"} at once.
          </p>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
