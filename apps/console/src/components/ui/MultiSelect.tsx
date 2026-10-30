import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

export interface MultiOption {
  value: string;
  label: string;
  /** A short explanation in the list, such as what an event means. */
  note?: string;
}

/**
 * Values chosen as tags, with a search over the options. With `custom`, a typed value that is
 * not an option is added on Enter or a comma, for values that no list knows (labels). A chosen
 * value that is not an option stays a tag, so an old value is never lost.
 */
export function MultiSelect({
  value,
  options,
  onChange,
  placeholder = "Search…",
  custom,
  mono,
  label,
}: {
  value: string[];
  options: MultiOption[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  custom?: boolean;
  mono?: boolean;
  /** For screen readers: what is chosen, such as "Events". */
  label: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useId();

  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const raw = query.trim();
  const q = raw.toLowerCase();
  const matches = options.filter(
    (o) =>
      !value.includes(o.value) &&
      (!q || [o.value, o.label, o.note ?? ""].some((text) => text.toLowerCase().includes(q))),
  );
  const typed = custom && raw && !byValue.has(raw) && !value.includes(raw) ? raw : null;
  const rows = [...matches.map((o) => o.value), ...(typed ? [typed] : [])];

  useEffect(() => setActive(0), [q, open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const add = (v: string) => {
    onChange([...value, v]);
    setQuery("");
    input.current?.focus();
  };
  const remove = (v: string) => onChange(value.filter((x) => x !== v));

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (rows.length) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === "Enter" || (custom && e.key === ",")) {
      // Enter here chooses; it never submits the form around the field.
      e.preventDefault();
      if (open && rows[active]) add(rows[active]!);
    } else if (e.key === "Backspace" && !query && value.length) {
      remove(value[value.length - 1]!);
    } else if (e.key === "Escape" && open) {
      // Close the list, not the dialog around it.
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="multi" ref={box}>
      <div
        className="multi-box input"
        onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}
        onClick={() => (input.current?.focus(), setOpen(true))}
      >
        {value.map((v) => (
          <span key={v} className={`multi-tag${mono ? " mono" : ""}`}>
            {byValue.get(v)?.label ?? v}
            <button
              type="button"
              aria-label={`Remove ${byValue.get(v)?.label ?? v}`}
              onClick={(e) => (e.stopPropagation(), remove(v))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={input}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={list}
          aria-activedescendant={open && rows[active] ? `${list}-${active}` : undefined}
          className={mono ? "mono" : ""}
          value={query}
          placeholder={value.length ? "" : placeholder}
          onChange={(e) => (setQuery(e.target.value), setOpen(true))}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
        />
      </div>
      {open && (
        <ul className="multi-list" id={list} role="listbox" aria-multiselectable="true">
          {rows.length === 0 ? (
            <li className="multi-empty">{options.length && !q ? "Everything is chosen." : "Nothing matches."}</li>
          ) : (
            rows.map((v, i) => {
              const o = byValue.get(v);
              return (
                <li
                  key={v}
                  id={`${list}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? "on" : ""}
                  onMouseEnter={() => setActive(i)}
                  // Before the input loses focus, so that the list stays open for the next choice.
                  onMouseDown={(e) => (e.preventDefault(), add(v))}
                >
                  <span className={mono ? "mono" : ""}>{o ? o.label : `Add "${v}"`}</span>
                  {o?.note && <small>{o.note}</small>}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
