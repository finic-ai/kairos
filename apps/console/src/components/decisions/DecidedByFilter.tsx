import { useState } from "react";
import { useDismiss } from "../../hooks/useDismiss";

export type DecidedBy = "action" | "workflow" | "policy";

export interface DecidedByOption {
  value: string;
  label: string;
  /** A heading the option sits under, such as the action of a policy rule. */
  group?: string;
}

const KINDS: [DecidedBy, string][] = [
  ["action", "Action"],
  ["workflow", "Workflow"],
  ["policy", "Policy"],
];
const ALL: Record<DecidedBy, string> = {
  action: "All actions",
  workflow: "All workflows",
  policy: "All policy rules",
};
const FIND_AFTER = 8;

/** What made the decisions to show: one action, one decision workflow, or one policy rule, or any of a kind. */
export function DecidedByFilter({
  by,
  chosen,
  options,
  onChange,
}: {
  by: DecidedBy;
  chosen: string;
  options: Record<DecidedBy, DecidedByOption[]>;
  onChange: (by: DecidedBy, chosen: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DecidedBy>(by);
  const [find, setFind] = useState("");
  const ref = useDismiss(open, () => setOpen(false));
  const active = by !== "action" || chosen !== "";
  const kindLabel = KINDS.find(([k]) => k === by)![1];
  const chosenLabel = options[by].find((o) => o.value === chosen)?.label ?? chosen;
  const pick = (value: string) => {
    setOpen(false);
    setFind("");
    onChange(tab, value);
  };
  const shown = options[tab].filter((o) =>
    `${o.label} ${o.group ?? ""}`.toLowerCase().includes(find.trim().toLowerCase()),
  );
  let group: string | undefined;
  return (
    <div className="menu-anchor decided-by" ref={ref}>
      <button
        type="button"
        className={`btn filter-btn ${active ? "in-use" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (setTab(by), setOpen(!open))}
      >
        <svg className="filter-icon" viewBox="0 0 20 20" aria-hidden>
          <path d="M3 5h14M6 10h8M8.5 15h3" />
        </svg>
        {active ? (
          <span>
            <span className="muted">{kindLabel}:</span> {chosen ? chosenLabel : "all"}
          </span>
        ) : (
          "Filter"
        )}
        <svg className="caret" viewBox="0 0 20 20" aria-hidden>
          <path d="m6 8 4 4 4-4" />
        </svg>
      </button>
      {active && (
        <button
          type="button"
          className="icon-btn filter-clear"
          aria-label="Clear the filter"
          onClick={() => onChange("action", "")}
        >
          ×
        </button>
      )}
      {open && (
        <div className="menu end decided-by-menu" role="menu">
          <div className="decided-by-head">Decided by</div>
          <div className="seg decided-by-tabs" role="tablist">
            {KINDS.map(([kind, label]) => (
              <button
                key={kind}
                type="button"
                role="tab"
                aria-selected={tab === kind}
                className={tab === kind ? "on" : ""}
                onClick={() => (setTab(kind), setFind(""))}
              >
                {label}
              </button>
            ))}
          </div>
          {options[tab].length > FIND_AFTER && (
            <input
              className="input compact"
              placeholder={tab === "policy" ? "Find a rule" : tab === "action" ? "Find an action" : "Find a workflow"}
              value={find}
              onChange={(e) => setFind(e.target.value)}
            />
          )}
          <div className="decided-by-list">
            {!find && (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={by === tab && chosen === ""}
                onClick={() => pick("")}
              >
                <span className="grow">{ALL[tab]}</span>
                {by === tab && chosen === "" && <span aria-hidden>✓</span>}
              </button>
            )}
            {shown.map((o) => {
              const heading = o.group && o.group !== group ? o.group : null;
              group = o.group;
              const on = by === tab && chosen === o.value;
              return [
                heading && (
                  <div key={`g:${heading}`} className="decided-by-group">
                    {heading}
                  </div>
                ),
                <button
                  key={o.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  onClick={() => pick(o.value)}
                >
                  <span className="grow">{o.label}</span>
                  {on && <span aria-hidden>✓</span>}
                </button>,
              ];
            })}
            {shown.length === 0 && (
              <p className="muted decided-by-empty">
                {options[tab].length === 0
                  ? tab === "workflow"
                    ? "No workflow makes decisions yet."
                    : tab === "policy"
                      ? "No action has policy rules yet."
                      : "No actions yet."
                  : "Nothing matches."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
