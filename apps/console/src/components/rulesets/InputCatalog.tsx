import { INPUT_CATALOG, INPUT_GROUPS, type CatalogInput } from "@kairos/core";
import { useState } from "react";

const TYPE_LABEL: Record<CatalogInput["type"], string> = {
  text: "Text",
  number: "Number",
  boolean: "Yes or no",
  list: "List",
  object: "Object",
};

export function InputCatalog({
  added,
  onAdd,
  onClose,
}: {
  added: ReadonlySet<string>;
  onAdd: (input: CatalogInput) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = INPUT_CATALOG.filter((i) => `${i.label} ${i.name} ${i.description}`.toLowerCase().includes(needle));
  return (
    <aside className="rs-catalog" aria-label="Input catalog">
      <div className="rs-catalog-head">
        <b>Catalog</b>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close the catalog">
          ×
        </button>
      </div>
      <input
        className="input"
        placeholder="Search inputs"
        aria-label="Search inputs"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="rs-catalog-list">
        {INPUT_GROUPS.map((group) => {
          const items = shown.filter((i) => i.group === group);
          if (!items.length) return null;
          return (
            <section key={group}>
              <div className="rs-catalog-group">{group}</div>
              {items.map((i) => {
                const has = added.has(i.name);
                return (
                  <button
                    key={i.name}
                    type="button"
                    className={`rs-catalog-item ${has ? "added" : ""}`}
                    title={i.description}
                    disabled={has}
                    onClick={() => onAdd(i)}
                  >
                    <span>
                      <b>{i.label}</b>
                      <small className="mono">{i.name}</small>
                    </span>
                    <small>{has ? "Added" : TYPE_LABEL[i.type]}</small>
                  </button>
                );
              })}
            </section>
          );
        })}
        {shown.length === 0 && <small className="muted">No input matches.</small>}
      </div>
    </aside>
  );
}
