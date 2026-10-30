import { useState } from "react";
import { importValue } from "@kairos/core";
import { api } from "../../api/index";
import { Modal } from "../ui/Modal";
import { type Pair, Pairs } from "../ui/Pairs";

const asText = (value: unknown) =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);

export function EditInfoModal({
  entity,
  properties,
  documented,
  onClose,
  onSaved,
}: {
  entity: { type: string; id: string };
  properties: Record<string, unknown>;
  documented: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [items, setItems] = useState<Pair[]>([
    ...Object.entries(properties).map(([name, value]): Pair => [name, asText(value)]),
    ...documented.filter((name) => !(name in properties)).map((name): Pair => [name, ""]),
  ]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const set: Record<string, unknown> = {};
    const kept = new Set<string>();
    for (const [rawName, text] of items) {
      const name = rawName.trim();
      if (!name) continue;
      const before = properties[name];
      if (name in properties && text === asText(before)) {
        kept.add(name);
        continue;
      }
      // A value that was JSON stays JSON when it still reads as JSON; any other value is read as an import reads it.
      let value: unknown = importValue(text);
      if (/^[[{]/.test(text.trim()) || (name in properties && typeof before === "object")) {
        try {
          value = JSON.parse(text);
        } catch {
          // Not JSON: keep it as text.
        }
      }
      if (value === undefined) continue;
      set[name] = value;
      kept.add(name);
    }
    const unset = Object.keys(properties).filter((name) => !kept.has(name));
    if (Object.keys(set).length === 0 && unset.length === 0) return onClose();
    setSaving(true);
    try {
      await api.saveEntity(entity, set, unset);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };
  return (
    <Modal title={`Edit ${entity.id}`} onClose={onClose}>
      <form className="modal-body" onSubmit={save}>
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <div className="field">
          <span>Properties</span>
          <Pairs items={items} onChange={setItems} codeHint="email" textHint="ada@example.com" />
          <small>
            An empty value, or a removed row, removes the property. Numbers and true/false are stored as such; a value
            with a leading zero, such as 02139, stays text. A change is a fact as of now: an older event that arrives
            later does not undo it.
          </small>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
