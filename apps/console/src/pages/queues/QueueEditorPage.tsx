import {
  CASE_PRIORITIES,
  MAX_COLUMNS,
  QUEUE_COLUMNS,
  ruleSentence,
  validateQueue,
  type IntakeCondition,
  type IntakeGroup,
  type IntakeNode,
  type IntakeOperator,
  type CasePriority,
  type IntakeRule,
  type Outcome,
  type QueueDefinition,
} from "@kairos/core";
import { useEffect, useMemo, useState } from "react";
import { queues } from "../../api/index";
import { EntityIcon } from "../../components/entities/EntityIcon";
import { IconColorFields } from "../../components/entities/IconColorFields";
import { InTopbar } from "../../components/shell/InTopbar";
import { Switch } from "../../components/ui/Switch";
import { Card } from "../../components/ui/Card";
import { ColumnPicker } from "../../components/ui/ColumnPicker";
import { ChoiceSelect } from "../../components/ui/ChoiceSelect";
import { Failure, Loading } from "../../components/ui/states";
import { useActions, useApi, useEntityTypeList } from "../../hooks/useApi";
import { actionName } from "../../lib/format";
import { OUTCOME_LABEL, OUTCOMES } from "../../lib/outcomes";
import {
  BLANK_QUEUE,
  CONDITION_FIELDS,
  OPERATORS,
  PRIORITY_LABEL,
  QUEUE_DISPLAY,
  columnLabel,
  definitionOf,
  fieldChoice,
  ruleId,
} from "../../lib/queues";
import { go, hashQuery, href } from "../../lib/route";
const isGroup = (n: IntakeNode): n is IntakeGroup => "all" in n || "any" in n;
const childrenOf = (g: IntakeGroup) => ("all" in g ? g.all : g.any);
const withChildren = (g: IntakeGroup, nodes: IntakeNode[]): IntakeGroup =>
  "all" in g ? { all: nodes } : { any: nodes };

/** A typed value from what a person wrote: a number, true or false, or text. */
const typed = (text: string): string | number | boolean => {
  const t = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  return t;
};
/** The value a condition keeps when its operator changes: a list for `in`, two numbers for `between`, else one value. */
function valueFor(op: IntakeOperator, value: unknown): unknown {
  const first = Array.isArray(value) ? value[0] : value;
  if (op === "in") return Array.isArray(value) ? value : first === "" || first === undefined ? [] : [first];
  if (op === "between") return [Number(first) || 0, Number(first) || 0];
  return first ?? "";
}

const listOf = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(typed);

function ConditionRow({
  condition,
  signals,
  onChange,
  onRemove,
}: {
  condition: IntakeCondition;
  signals: string[];
  onChange: (c: IntakeCondition) => void;
  onRemove: () => void;
}) {
  const choice = fieldChoice(condition.field);
  const name = choice.named ? condition.field.slice(choice.value.length) : "";
  const ops = OPERATORS[choice.kind];
  const setField = (value: string) => {
    const next = CONDITION_FIELDS.find((f) => f.value === value)!;
    const op = OPERATORS[next.kind][0]![0];
    onChange({
      field: next.named ? `${next.value}${next.kind === "signal" ? (signals[0] ?? "") : ""}` : next.value,
      op,
      value: next.kind === "outcome" ? ["review"] : next.kind === "score" ? 50 : next.kind === "signal" ? 0.8 : "",
    });
  };
  const setOp = (op: IntakeOperator) => onChange({ ...condition, op, value: valueFor(op, condition.value) });
  const value = condition.value;
  return (
    <div className="filter-row condition">
      <select className="input" value={choice.value} onChange={(e) => setField(e.target.value)} aria-label="Field">
        {CONDITION_FIELDS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      {choice.named &&
        (choice.kind === "signal" && signals.length > 0 ? (
          <ChoiceSelect
            mono
            value={name}
            options={signals}
            placeholder="Choose a signal"
            other="Another signal…"
            onChange={(v) => onChange({ ...condition, field: `${choice.value}${v}` })}
          />
        ) : (
          <input
            className="input mono"
            placeholder={choice.kind === "signal" ? "identity_mismatch" : "amount"}
            value={name}
            onChange={(e) => onChange({ ...condition, field: `${choice.value}${e.target.value.trim()}` })}
          />
        ))}
      {ops.length > 1 ? (
        <select className="input" value={condition.op} onChange={(e) => setOp(e.target.value as IntakeOperator)}>
          {ops.map(([op, label]) => (
            <option key={op} value={op}>
              {label}
            </option>
          ))}
        </select>
      ) : (
        <span className="muted">{ops[0]![1]}</span>
      )}
      {choice.kind === "outcome" ? (
        <span className="row wrap" style={{ gap: 10 }}>
          {OUTCOMES.map((o) => {
            const list = (Array.isArray(value) ? value : []) as Outcome[];
            return (
              <label key={o} className="check">
                <input
                  type="checkbox"
                  checked={list.includes(o)}
                  onChange={(e) =>
                    onChange({ ...condition, value: e.target.checked ? [...list, o] : list.filter((x) => x !== o) })
                  }
                />{" "}
                {OUTCOME_LABEL[o]}
              </label>
            );
          })}
        </span>
      ) : condition.op === "between" ? (
        <>
          {[0, 1].map((i) => (
            <input
              key={i}
              className="input mono"
              inputMode="decimal"
              style={{ width: 90 }}
              value={String((Array.isArray(value) ? value[i] : "") ?? "")}
              onChange={(e) => {
                const pair = Array.isArray(value) ? [...value] : [0, 0];
                pair[i] = typed(e.target.value);
                onChange({ ...condition, value: pair });
              }}
            />
          ))}
        </>
      ) : condition.op === "in" ? (
        <input
          className="input mono"
          placeholder="one, two"
          value={Array.isArray(value) ? value.join(", ") : ""}
          onChange={(e) => onChange({ ...condition, value: listOf(e.target.value) })}
        />
      ) : (
        <input
          className="input mono"
          inputMode={choice.kind === "score" || choice.kind === "signal" ? "decimal" : undefined}
          placeholder={choice.kind === "score" ? "80" : choice.kind === "signal" ? "0.9" : "value"}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange({ ...condition, value: typed(e.target.value) })}
        />
      )}
      <button className="icon-btn" aria-label="Remove this condition" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

function RuleEditor({
  rule,
  signals,
  onChange,
  onRemove,
}: {
  rule: IntakeRule;
  signals: string[];
  onChange: (r: IntakeRule) => void;
  onRemove: () => void;
}) {
  const nodes = childrenOf(rule.conditions);
  const setNodes = (next: IntakeNode[]) => onChange({ ...rule, conditions: withChildren(rule.conditions, next) });
  return (
    <div className="card pad" style={{ marginBottom: 12 }}>
      <div className="row wrap" style={{ gap: 10, marginBottom: 10 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 180 }}
          aria-label="Rule name"
          value={rule.name}
          onChange={(e) => onChange({ ...rule, name: e.target.value })}
        />
        <select
          className="input"
          style={{ width: "auto" }}
          aria-label="Priority"
          value={rule.priority ?? "normal"}
          onChange={(e) => onChange({ ...rule, priority: e.target.value as IntakeRule["priority"] })}
        >
          {CASE_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]} priority
            </option>
          ))}
        </select>
        <Switch
          checked={rule.enabled !== false}
          onChange={(enabled) => onChange({ ...rule, enabled })}
          label={rule.enabled !== false ? "Enabled" : "Disabled"}
        />
        <button className="btn ghost" onClick={onRemove}>
          Remove rule
        </button>
      </div>
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <span className="muted" style={{ whiteSpace: "nowrap" }}>
          Open a case when
        </span>
        <select
          className="input"
          style={{ width: "auto" }}
          value={"all" in rule.conditions ? "all" : "any"}
          onChange={(e) =>
            onChange({ ...rule, conditions: e.target.value === "all" ? { all: nodes } : { any: nodes } })
          }
        >
          <option value="any">any</option>
          <option value="all">all</option>
        </select>
        <span className="muted" style={{ whiteSpace: "nowrap" }}>
          of these hold:
        </span>
      </div>
      {nodes.map((node, i) =>
        isGroup(node) ? (
          <div key={i} className="filter-row">
            <span>({ruleSentence(node)})</span>
            <button
              className="icon-btn"
              aria-label="Remove this group"
              onClick={() => setNodes(nodes.filter((_, at) => at !== i))}
            >
              ×
            </button>
          </div>
        ) : (
          <ConditionRow
            key={i}
            condition={node}
            signals={signals}
            onChange={(c) => setNodes(nodes.map((n, at) => (at === i ? c : n)))}
            onRemove={() => setNodes(nodes.filter((_, at) => at !== i))}
          />
        ),
      )}
      <button
        className="btn"
        style={{ marginTop: 6 }}
        onClick={() => setNodes([...nodes, { field: "decision.risk_score", op: ">=", value: 80 }])}
      >
        + Condition
      </button>
      {nodes.length > 0 && (
        <p className="note" style={{ margin: "10px 0 0" }}>
          {ruleSentence(rule.conditions)}.
        </p>
      )}
    </div>
  );
}

export function QueueEditorPage({ id }: { id: string }) {
  const isNew = id === "new";
  const { data: existing, error } = useApi(["queue", id], () => queues.get(id), { enabled: !isNew });
  const { data: actionList } = useActions();
  const { data: typeList } = useEntityTypeList();
  const [draft, setDraft] = useState<QueueDefinition | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);

  useEffect(() => {
    if (isNew) {
      const action = hashQuery().get("action");
      setDraft({ ...BLANK_QUEUE, sources: { actions: action ? [action] : [] } });
    } else if (existing && !draft) setDraft(definitionOf(existing));
  }, [existing]);

  const signals = useMemo(() => {
    const chosen = new Set(draft?.sources.actions ?? []);
    return [
      ...new Set(
        (actionList?.actions ?? []).filter((a) => chosen.has(a.name)).flatMap((a) => Object.keys(a.reasons ?? {})),
      ),
    ];
  }, [actionList, draft?.sources.actions]);

  if (error) return <Failure message={error.message} />;
  if (!draft) return <Loading />;
  const problems = validateQueue(draft);
  const set = (patch: Partial<QueueDefinition>) => setDraft({ ...draft, ...patch });
  const setDue = (priority: CasePriority, text: string) => {
    const { [priority]: _, ...rest } = draft.due_hours ?? {};
    const hours = Number(text);
    const next = text.trim() && Number.isFinite(hours) ? { ...rest, [priority]: hours } : rest;
    set({ due_hours: Object.keys(next).length ? next : undefined });
  };
  const setRule = (i: number, rule: IntakeRule) => set({ intake: draft.intake.map((r, at) => (at === i ? rule : r)) });
  const c = draft.correlation;
  const display = QUEUE_DISPLAY(draft);

  const save = async () => {
    setShowProblems(true);
    if (problems.length) return;
    setSaving(true);
    setProblem(null);
    try {
      const saved = isNew ? await queues.create(draft) : await queues.save(id, draft);
      go("queues", saved.id);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Delete the queue "${existing?.name ?? draft.name}"?`)) return;
    setProblem(null);
    try {
      await queues.remove(id);
      go("queues");
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  return (
    <>
      <InTopbar slot="trail-slot">
        {isNew ? (
          <span className="here">New</span>
        ) : (
          <>
            <a href={href("queues", id)}>{existing?.name ?? "Queue"}</a>
            <span>›</span>
            <span className="here">Edit</span>
          </>
        )}
      </InTopbar>
      <header className="page-head with-actions">
        <div>
          <h1>{isNew ? "New queue" : "Edit queue"}</h1>
          <p className="lede">
            A queue collects the decisions that need a person. Choose the decisions it watches, when one opens a case,
            and how decisions group into one case.
          </p>
        </div>
        <div className="row">
          <a className="btn ghost" href={isNew ? href("queues") : href("queues", id)}>
            Cancel
          </a>
          <button className="btn primary" disabled={saving} onClick={save}>
            {saving ? "Saving…" : isNew ? "Create queue" : "Save changes"}
          </button>
        </div>
      </header>

      {problem && <div className="banner">{problem}</div>}
      {showProblems && problems.length > 0 && (
        <div className="banner">
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}

      <div className="split queue-editor">
        <div className="stack">
          <Card title="Queue">
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                placeholder="Onboarding review"
                value={draft.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea
                className="input"
                rows={2}
                maxLength={500}
                placeholder="New accounts held for an identity check, for the onboarding team"
                value={draft.description ?? ""}
                onChange={(e) => set({ description: e.target.value })}
              />
            </label>
            <div className="field-pair">
              <div className="field">
                <span>Status</span>
                <Switch
                  checked={draft.enabled !== false}
                  onChange={(enabled) => set({ enabled })}
                  label={draft.enabled !== false ? "Enabled" : "Disabled"}
                />
                <small>
                  {draft.enabled !== false ? "Rules and workflows add cases." : "Takes no new cases. Its cases stay."}
                </small>
              </div>
              <label className="field">
                <span>Visibility</span>
                <select
                  className="input"
                  value={draft.visibility}
                  onChange={(e) => set({ visibility: e.target.value as QueueDefinition["visibility"] })}
                >
                  <option value="workspace">Everyone in the workspace</option>
                  <option value="private">Only me</option>
                </select>
              </label>
            </div>
          </Card>

          <Card title="Decisions to watch">
            <p className="section-note">
              The actions whose decisions this queue looks at. A decision of any other action never makes a case here.
            </p>
            {(actionList?.actions ?? []).length === 0 && <span className="muted">No actions yet. Make one first.</span>}
            <div className="option-list">
              {(actionList?.actions ?? []).map((a) => {
                const list = draft.sources.actions ?? [];
                return (
                  <label key={a.name} className="option">
                    <input
                      type="checkbox"
                      checked={list.includes(a.name)}
                      onChange={(e) =>
                        set({
                          sources: {
                            ...draft.sources,
                            actions: e.target.checked ? [...list, a.name] : list.filter((x) => x !== a.name),
                          },
                        })
                      }
                    />
                    <span className="grow">{actionName(a)}</span>
                    <span className="mono muted">{a.name}</span>
                  </label>
                );
              })}
            </div>
          </Card>

          <section>
            <div className="section-head">
              <h2>When to open a case</h2>
              <p className="section-note">
                Each decision is tested against these rules a few seconds after it is made. When it matches one, it
                opens a case, or joins the open case it belongs to. A decision that matches no rule makes no case.
              </p>
            </div>
            {draft.intake.map((rule, i) => (
              <RuleEditor
                key={i}
                rule={rule}
                signals={signals}
                onChange={(r) => setRule(i, r)}
                onRemove={() => set({ intake: draft.intake.filter((_, at) => at !== i) })}
              />
            ))}
            <button
              className="btn"
              onClick={() => {
                const name = `Rule ${draft.intake.length + 1}`;
                set({
                  intake: [
                    ...draft.intake,
                    {
                      id: ruleId(
                        name,
                        draft.intake.map((r) => r.id),
                      ),
                      name,
                      priority: "normal",
                      conditions: { any: [{ field: "decision.outcome", op: "in", value: ["review"] }] },
                    },
                  ],
                });
              }}
            >
              + Add a rule
            </button>
          </section>
        </div>

        <aside className="stack">
          <Card title="Case grouping">
            <p className="section-note">
              Which decisions belong to the same case. With "Subject", every matching decision about one user goes into
              that user's open case.
            </p>
            <label className="field">
              <span>Group by</span>
              <select
                className="input"
                value={c.by}
                onChange={(e) => {
                  const by = e.target.value as typeof c.by;
                  set({
                    correlation: {
                      by,
                      ...(by === "entity" ? { type: c.type ?? "" } : {}),
                      ...(by === "request" ? { property: c.property ?? "" } : {}),
                      ...(by === "session" || by === "event"
                        ? {}
                        : {
                            window_days: c.window_days ?? 30,
                            ...(c.reopen_days ? { reopen_days: c.reopen_days } : {}),
                          }),
                      when_missing: c.when_missing ?? "create",
                    },
                  });
                }}
              >
                <option value="subject">Subject of the decision</option>
                <option value="entity">An entity the decisions name</option>
                <option value="request">A request property</option>
                <option value="session">Session</option>
                <option value="event">Event that starts the decision</option>
              </select>
            </label>
            {c.by === "entity" && (
              <label className="field">
                <span>Entity type</span>
                <ChoiceSelect
                  mono
                  value={c.type ?? ""}
                  options={typeList?.types.map((t) => t.type) ?? []}
                  placeholder="Choose an entity type"
                  other="Another entity type…"
                  onChange={(v) => set({ correlation: { ...c, type: v } })}
                />
              </label>
            )}
            {c.by === "request" && (
              <label className="field">
                <span>Request property</span>
                <input
                  className="input mono"
                  placeholder="application_id"
                  value={c.property ?? ""}
                  onChange={(e) => set({ correlation: { ...c, property: e.target.value.trim() } })}
                />
              </label>
            )}
            {c.by !== "session" && c.by !== "event" && (
              <label className="field">
                <span>Keep a case open to new decisions for</span>
                <div className="input-unit">
                  <input
                    className="input"
                    inputMode="numeric"
                    value={c.window_days ?? 30}
                    onChange={(e) => set({ correlation: { ...c, window_days: Number(e.target.value) || 0 } })}
                  />
                  <span>days of quiet</span>
                </div>
              </label>
            )}
            {c.by !== "session" && c.by !== "event" && (
              <>
                <label className="field">
                  <span>A trigger after the case is resolved</span>
                  <select
                    className="input"
                    value={c.reopen_days !== undefined ? "reopen" : "new"}
                    onChange={(e) => {
                      const { reopen_days: _, ...rest } = c;
                      set({ correlation: e.target.value === "reopen" ? { ...rest, reopen_days: 7 } : rest });
                    }}
                  >
                    <option value="new">Opens a new case</option>
                    <option value="reopen">Reopens the case</option>
                  </select>
                </label>
                {c.reopen_days !== undefined && (
                  <label className="field">
                    <span>When it was resolved in the last</span>
                    <div className="input-unit">
                      <input
                        className="input"
                        inputMode="numeric"
                        value={c.reopen_days}
                        onChange={(e) => set({ correlation: { ...c, reopen_days: Number(e.target.value) || 0 } })}
                      />
                      <span>days</span>
                    </div>
                  </label>
                )}
              </>
            )}
            <label className="field">
              <span>A decision with nothing to group by</span>
              <select
                className="input"
                value={c.when_missing ?? "create"}
                onChange={(e) => set({ correlation: { ...c, when_missing: e.target.value as "create" | "skip" } })}
              >
                <option value="create">Opens a case of its own</option>
                <option value="skip">Opens no case</option>
              </select>
            </label>
          </Card>

          <Card title="Due times">
            <p className="section-note">
              How long a case can wait, by its priority. A case past its due time counts as overdue. Empty: no due time.
            </p>
            {(
              [
                ["urgent", "high"],
                ["normal", "low"],
              ] as const
            ).map((pair) => (
              <div key={pair.join()} className="field-pair">
                {pair.map((p) => (
                  <label key={p} className="field">
                    <span>{PRIORITY_LABEL[p]}</span>
                    <div className="input-unit">
                      <input
                        className="input"
                        inputMode="decimal"
                        placeholder="None"
                        value={draft.due_hours?.[p] ?? ""}
                        onChange={(e) => setDue(p, e.target.value)}
                      />
                      <span>hours</span>
                    </div>
                  </label>
                ))}
              </div>
            ))}
          </Card>

          <Card title="Case list columns">
            <p className="section-note">
              The columns the queue's list shows, from left to right. Drag a column, or use the arrows, to move it.
            </p>
            <ColumnPicker
              columns={draft.columns ?? []}
              onChange={(columns) => set({ columns })}
              options={[...QUEUE_COLUMNS]}
              labelOf={columnLabel}
              max={MAX_COLUMNS}
              custom={{
                prefixes: ["request.", "subject."],
                option: "A property of the request or the entity…",
                placeholder: "request.amount or subject.country",
                note: "request. is a property the decision was asked with; subject. is a property of the case's entity.",
              }}
            />
            <label className="field" style={{ marginTop: 16 }}>
              <span>Sort cases by</span>
              <select
                className="input"
                value={draft.sort ?? "oldest"}
                onChange={(e) => set({ sort: e.target.value as QueueDefinition["sort"] })}
              >
                <option value="oldest">Oldest first</option>
                <option value="newest">Newest first</option>
                <option value="priority">Highest priority first</option>
                <option value="risk">Highest risk first</option>
                <option value="due">Soonest due first</option>
              </select>
            </label>
          </Card>

          <Card title="Display">
            <div className="stack" style={{ gap: 16 }}>
              <div className="display-preview">
                <EntityIcon icon={display.icon} color={display.color} size="lg" />
                <div>
                  <div className="entity-label">{draft.name.trim() || "Queue name"}</div>
                  {draft.description?.trim() && <div className="entity-id">{draft.description.trim()}</div>}
                </div>
              </div>
              <IconColorFields
                icon={draft.display?.icon ?? ""}
                color={draft.display?.color ?? ""}
                fallback={QUEUE_DISPLAY({})}
                onChange={(patch) => {
                  const next = { ...draft.display, ...patch };
                  set({
                    display: {
                      ...(next.icon ? { icon: next.icon } : {}),
                      ...(next.color ? { color: next.color } : {}),
                      ...(next.view ? { view: next.view } : {}),
                    },
                  });
                }}
              />
            </div>
          </Card>

          <Card title="Case Layout">
            <p className="section-note">Create a custom view and layout for this queue's cases.</p>
            {isNew ? (
              <small className="muted">Save the queue first.</small>
            ) : (
              <a className="btn" href={href("queues", id, "page")}>
                Edit Case Layout
              </a>
            )}
          </Card>

          {!isNew && existing?.can_manage && (
            <Card title="Delete">
              <p className="section-note">
                A queue with cases cannot be deleted. Disable it instead: it then takes no new cases, and its cases
                stay.
              </p>
              <button className="btn danger" onClick={remove}>
                Delete queue
              </button>
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}
