import { useEffect, useRef, useState } from "react";
import {
  emptyGroup,
  emptyRule,
  fromCel,
  incomplete,
  OPS,
  takesValue,
  toCel,
  type Group,
  type Op,
  type Rule,
} from "../../lib/conditions";
import { ChoiceSelect } from "../ui/ChoiceSelect";

function RuleRow({
  rule,
  fields,
  lists,
  onChange,
  onRemove,
}: {
  rule: Rule;
  fields: string[];
  lists?: string[];
  onChange: (rule: Rule) => void;
  onRemove: () => void;
}) {
  return (
    <div className="wf-rule">
      <ChoiceSelect
        mono
        value={rule.field}
        options={fields}
        placeholder="Choose a field"
        other="Another field…"
        onChange={(field) => onChange({ ...rule, field })}
      />
      <div className="wf-rule-line">
        <select
          className="input"
          value={rule.op}
          onChange={(e) => onChange({ ...rule, op: e.target.value as Op })}
          aria-label="Operator"
        >
          {OPS.filter((o) => lists || o.op !== "inlist").map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>
        {rule.op === "inlist" ? (
          <select
            className="input mono"
            value={rule.value}
            aria-label="List"
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
          >
            <option value="">Choose a list</option>
            {[...new Set([...(lists ?? []), rule.value].filter(Boolean))].map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        ) : (
          takesValue(rule.op) && (
            <input
              className="input mono"
              placeholder={rule.op === "in" ? "one, two" : "value"}
              value={rule.value}
              aria-label="Value"
              onChange={(e) => onChange({ ...rule, value: e.target.value })}
            />
          )
        )}
        <button type="button" className="icon-btn" onClick={onRemove} aria-label="Remove the condition">
          ×
        </button>
      </div>
    </div>
  );
}

function GroupEditor({
  group,
  fields,
  lists,
  nested,
  onChange,
  onRemove,
}: {
  group: Group;
  fields: string[];
  lists?: string[];
  nested?: boolean;
  onChange: (group: Group) => void;
  onRemove?: () => void;
}) {
  const setItem = (i: number, item: Rule | Group) =>
    onChange({ ...group, items: group.items.map((x, j) => (j === i ? item : x)) });
  const removeItem = (i: number) => onChange({ ...group, items: group.items.filter((_, j) => j !== i) });
  return (
    <div className={nested ? "wf-cond-group" : undefined}>
      <div className="wf-cond-join">
        <span>Match</span>
        <select
          className="input"
          value={group.join}
          onChange={(e) => onChange({ ...group, join: e.target.value as Group["join"] })}
          aria-label="Match"
        >
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        <span>{nested ? "of these" : "of these conditions"}</span>
        {onRemove && (
          <button type="button" className="icon-btn" onClick={onRemove} aria-label="Remove the group">
            ×
          </button>
        )}
      </div>
      {group.items.map((item, i) =>
        item.kind === "rule" ? (
          <RuleRow
            key={i}
            rule={item}
            fields={fields}
            lists={lists}
            onChange={(r) => setItem(i, r)}
            onRemove={() => removeItem(i)}
          />
        ) : (
          <GroupEditor
            key={i}
            group={item}
            fields={fields}
            lists={lists}
            nested
            onChange={(g) => setItem(i, g)}
            onRemove={() => removeItem(i)}
          />
        ),
      )}
      <div className="row">
        <button
          type="button"
          className="btn"
          onClick={() => onChange({ ...group, items: [...group.items, emptyRule()] })}
        >
          + Add a condition
        </button>
        {!nested && (
          <button
            type="button"
            className="btn"
            onClick={() =>
              onChange({
                ...group,
                items: [...group.items, { ...emptyGroup(group.join === "all" ? "any" : "all"), items: [emptyRule()] }],
              })
            }
          >
            + Add a group
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Build a condition from rules, or write it as a CEL expression. The value is the CEL either
 * way. A CEL the builder cannot show stays an expression, so nothing is lost.
 */
export function ConditionBuilder({
  value,
  onChange,
  fields,
  lists,
  placeholder,
}: {
  value: string;
  onChange: (cel: string) => void;
  fields: string[];
  /** The slugs of the lists that "is in the list" offers. Without them, the builder does not offer it. */
  lists?: string[];
  placeholder?: string;
}) {
  const [group, setGroup] = useState<Group>(() => fromCel(value) ?? emptyGroup());
  const [mode, setMode] = useState<"build" | "expression">(() => (fromCel(value) ? "build" : "expression"));
  const written = useRef(value);

  // A change from outside (undo, another step) shows: the builder reads it, if it can.
  useEffect(() => {
    if (value === written.current) return;
    written.current = value;
    const read = fromCel(value);
    if (read) setGroup(read);
    else setMode("expression");
  }, [value]);

  const update = (next: Group) => {
    setGroup(next);
    const cel = toCel(next);
    written.current = cel;
    onChange(cel);
  };
  const left = incomplete(group);
  const readable = fromCel(value) !== null;

  if (mode === "expression")
    return (
      <div className="wf-cond">
        <textarea
          className="input mono"
          rows={3}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            written.current = e.target.value;
            onChange(e.target.value);
          }}
        />
        <div className="wf-cond-foot">
          <small className="muted">A CEL expression.</small>
          <button
            type="button"
            className="linkish"
            disabled={!readable}
            title={
              readable ? undefined : "The builder cannot show this expression: it uses more than rules and groups."
            }
            onClick={() => {
              setGroup(fromCel(value) ?? emptyGroup());
              setMode("build");
            }}
          >
            Use the builder
          </button>
        </div>
      </div>
    );

  return (
    <div className="wf-cond">
      <GroupEditor group={group} fields={fields} lists={lists} onChange={update} />
      {left > 0 && (
        <small className="wh-failed">
          {left === 1 ? "1 condition is" : `${left} conditions are`} not complete yet, and left out.
        </small>
      )}
      <div className="wf-cond-foot">
        <small className="mono muted wf-cond-cel">{toCel(group) || "No condition"}</small>
        <button type="button" className="linkish" onClick={() => setMode("expression")}>
          Write an expression
        </button>
      </div>
    </div>
  );
}
