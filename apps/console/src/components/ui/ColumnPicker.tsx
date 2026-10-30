import { useState, type ReactNode } from "react";

export function ColumnPicker({
  columns,
  onChange,
  options,
  labelOf,
  max,
  custom,
  extra,
  noun = "column",
}: {
  columns: string[];
  onChange: (columns: string[]) => void;
  options: string[];
  labelOf: (column: string) => string;
  max: number;
  /** A column named by a property, with one of these prefixes. The first is added to a bare name. */
  custom?: { prefixes: string[]; option: string; placeholder: string; note: string };
  extra?: (column: string) => ReactNode;
  noun?: string;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const full = columns.length >= max;
  const remaining = options.filter((col) => !columns.includes(col));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= columns.length || from === to) return;
    const next = [...columns];
    const [col] = next.splice(from, 1);
    next.splice(to, 0, col!);
    onChange(next);
  };
  const addCustom = () => {
    const raw = (typed ?? "").trim().replace(/\s+/g, "_");
    if (!raw || !custom) return;
    const path = custom.prefixes.some((p) => raw.startsWith(p)) ? raw : `${custom.prefixes[0]}${raw}`;
    if (!columns.includes(path)) onChange([...columns, path]);
    setTyped(null);
  };
  return (
    <>
      <div className="column-list" onDragLeave={() => setOver(null)}>
        {columns.length === 0 && <div className="column-empty">No {noun}s. Add one below.</div>}
        {columns.map((col, i) => (
          <div
            key={col}
            className={`column-item ${dragging === i ? "dragging" : ""} ${over === i && dragging !== i ? "over" : ""}`}
            draggable
            onDragStart={(e) => (setDragging(i), (e.dataTransfer.effectAllowed = "move"))}
            onDragOver={(e) => (e.preventDefault(), setOver(i))}
            onDrop={(e) => (
              e.preventDefault(),
              dragging !== null && move(dragging, i),
              setDragging(null),
              setOver(null)
            )}
            onDragEnd={() => (setDragging(null), setOver(null))}
          >
            <span className="handle" aria-hidden>
              <svg viewBox="0 0 20 20">
                <circle cx="7.5" cy="5" r="1.3" />
                <circle cx="12.5" cy="5" r="1.3" />
                <circle cx="7.5" cy="10" r="1.3" />
                <circle cx="12.5" cy="10" r="1.3" />
                <circle cx="7.5" cy="15" r="1.3" />
                <circle cx="12.5" cy="15" r="1.3" />
              </svg>
            </span>
            <span className="grow">
              {labelOf(col)}
              {col.includes(".") && <span className="mono muted"> {col}</span>}
            </span>
            {extra?.(col)}
            <button
              type="button"
              className="icon-btn"
              aria-label={`Move ${labelOf(col)} up`}
              disabled={i === 0}
              onClick={() => move(i, i - 1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Move ${labelOf(col)} down`}
              disabled={i === columns.length - 1}
              onClick={() => move(i, i + 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove ${labelOf(col)}`}
              onClick={() => onChange(columns.filter((x) => x !== col))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {typed === null ? (
        <select
          className="input"
          style={{ marginTop: 8 }}
          aria-label="Add a column"
          value=""
          disabled={full}
          onChange={(e) => {
            const value = e.target.value;
            if (value === "\u0000custom") setTyped("");
            else if (value) onChange([...columns, value]);
          }}
        >
          <option value="">{full ? `At most ${max} ${noun}s` : `+ Add a ${noun}`}</option>
          {remaining.map((col) => (
            <option key={col} value={col}>
              {labelOf(col)}
            </option>
          ))}
          {custom && <option value={"\u0000custom"}>{custom.option}</option>}
        </select>
      ) : (
        <form
          className="row"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            addCustom();
          }}
        >
          <input
            className="input mono grow"
            autoFocus
            placeholder={custom?.placeholder}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <button className="btn" disabled={!typed.trim()}>
            Add
          </button>
          <button type="button" className="btn ghost" onClick={() => setTyped(null)}>
            Cancel
          </button>
        </form>
      )}
      {typed !== null && custom && (
        <small className="muted" style={{ display: "block", marginTop: 6 }}>
          {custom.note}
        </small>
      )}
    </>
  );
}
