import { useState } from "react";
import { importValue } from "@kairos/core";
import { api } from "../../api/index";
import { Modal } from "../ui/Modal";
import { type Pair, Pairs } from "../ui/Pairs";
import { entityName } from "../../lib/format";
import { go } from "../../lib/route";

export function AddEntityModal({ type, known, onClose }: { type: string; known: string[]; onClose: () => void }) {
  const [id, setId] = useState("");
  const [properties, setProperties] = useState<Pair[]>(known.map((name) => [name, ""]));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!id.trim()) return setError("Give the entity an id.");
    setSaving(true);
    try {
      // The same rules as an import: plain numbers and true/false get their type, a code with a
      // leading zero stays text, and an empty value is no property.
      const parsed = Object.fromEntries(
        properties.flatMap(([name, value]) => {
          const stored = importValue(value);
          return name.trim() && stored !== undefined ? [[name.trim(), stored]] : [];
        }),
      );
      await api.saveEntity({ type, id: id.trim() }, parsed);
      go("entities", type, id.trim());
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };
  return (
    <Modal title={`Add ${entityName(type).toLowerCase()}`} onClose={onClose}>
      <form className="modal-body" onSubmit={save}>
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <label className="field">
          <span>Id</span>
          <input
            className="input mono"
            placeholder={`${type}_123`}
            value={id}
            onChange={(e) => setId(e.target.value)}
            autoFocus
          />
          <small>
            Your own identifier. Events that name this id attach to the same {entityName(type).toLowerCase()}.
          </small>
        </label>
        <div className="field">
          <span>Properties</span>
          <Pairs items={properties} onChange={setProperties} codeHint="country" textHint="GB" />
          <small>
            Numbers and true/false are stored as such. A value with a leading zero, such as 02139, stays text.
          </small>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving}>
            {saving ? "Adding…" : `Add ${entityName(type).toLowerCase()}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
