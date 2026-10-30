import { useEffect, useState } from "react";
import { api } from "../../api/index";
import type { ActionDefinition } from "../../types/interfaces";
import type { Outcome, PolicyRule, TotalCondition, TotalDefinition } from "../../types/interfaces";
import { AutomaticField } from "../../components/actions/AutomaticField";
import { TotalForm } from "../../components/actions/TotalForm";
import { Card } from "../../components/ui/Card";
import { ChoiceSelect } from "../../components/ui/ChoiceSelect";
import { Pairs } from "../../components/ui/Pairs";
import { Failure, Loading } from "../../components/ui/states";
import { TemplateModal } from "../../components/ui/TemplateModal";
import { useActions, useApi, useEntityTypeList } from "../../hooks/useApi";
import { BLANK, cleanTotal, toDefinition, toDraft, type Draft } from "../../lib/actions";
import { actionName, entityName, slug } from "../../lib/format";
import { OUTCOME_LABEL, OUTCOMES } from "../../lib/outcomes";
import { go, href } from "../../lib/route";

export function ActionEditorPage({ name }: { name: string }) {
  const isNew = name === "new";
  const { data: existing, error: loadError } = useApi(["action", name], () => api.action(name), {
    enabled: !isNew,
  });
  const [draft, setDraft] = useState<Draft>(BLANK);
  const { data: templates } = useApi(["templates"], () => api.templates(), { enabled: isNew });
  const templateList = templates?.templates ?? [];
  const [picking, setPicking] = useState<"start" | "list" | null>(isNew ? "start" : null);
  const { data: defined } = useActions();
  const [from, setFrom] = useState<ActionDefinition | undefined>();
  const [totals, setTotals] = useState<TotalDefinition[]>([]);
  const [keyTouched, setKeyTouched] = useState(false);
  // "From an event" stays chosen while the event type is still empty.
  const [byEvent, setByEvent] = useState(false);
  const { data: typeList } = useEntityTypeList();
  const { data: metricOptions } = useApi(["metric-options", undefined], () => api.metricOptions());
  const use = (t: ActionDefinition) => (
    setFrom(t),
    setTotals(t.context?.totals ?? []),
    setDraft(toDraft(t)),
    setKeyTouched(true),
    setByEvent(!!t.trigger),
    setSaved(null),
    setError(null)
  );
  const exists = isNew && defined?.actions.find((a) => a.name === draft.name.trim());
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (existing)
      (setDraft(toDraft(existing)), setByEvent(!!existing.trigger), setTotals(existing.context?.totals ?? []));
  }, [existing]);

  if (loadError) return <Failure message={loadError.message} />;
  if (!isNew && !existing) return <Loading />;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => (
    setDraft({ ...draft, [key]: value }),
    setSaved(null)
  );
  const subjects = [...new Set([...(typeList?.types.map((t) => t.type) ?? []), draft.subject].filter(Boolean))];
  const eventTypes = [...new Set([...(metricOptions?.event_types ?? []), draft.trigger].filter(Boolean))];
  const startsBy = byEvent || draft.trigger.trim() !== "";
  const codes = draft.reasons.map(([code]) => code.trim()).filter(Boolean);
  const setRule = (i: number, patch: Partial<PolicyRule>) =>
    set(
      "rules",
      draft.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    );

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const incomplete = totals.find((t) => !t.name.trim() || !t.event.trim() || !t.sum.trim());
      if (incomplete)
        throw new Error(`Totals: "${incomplete.name || "a total"}" needs a name, an event and a property to add up.`);
      const definition = toDefinition(
        startsBy ? draft : { ...draft, trigger: "", triggerStatus: "" },
        existing ?? from,
      );
      const { totals: _old, ...context } = definition.context ?? {};
      const withTotals = { ...context, ...(totals.length ? { totals: totals.map(cleanTotal) } : {}) };
      const stored = await api.saveAction({
        ...definition,
        ...(Object.keys(withTotals).length ? { context: withTotals } : { context: undefined }),
      });
      setSaved(`${stored.name}@${stored.version}`);
      go("actions", stored.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <a className="crumb" href={isNew ? href("actions") : href("actions", name)}>
        ← {isNew ? "Actions" : draft.label || entityName(draft.name)}
      </a>
      <header className="page-head with-actions">
        <div>
          <h1>{isNew ? "New action" : `Edit ${draft.label || entityName(draft.name)}`}</h1>
          <p className="lede">
            {isNew
              ? "Describe the decision. No rules engine and no feature code: the model reads the question as you write it."
              : "Saving a change to the wording creates a new version. Past decisions keep the version they used."}
          </p>
        </div>
        <div className="row">
          {isNew && templateList.length > 0 && (
            <button className="btn" onClick={() => setPicking("list")}>
              Use a template
            </button>
          )}
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : isNew ? "Create action" : "Save new version"}
          </button>
        </div>
      </header>

      {error && <Failure message={error} />}
      {saved && <div className="banner ok">Saved as {saved}.</div>}

      {isNew && picking && templateList.length > 0 && (
        <TemplateModal
          key={picking}
          title="New action"
          options={templateList.map((t) => ({
            id: t.name,
            title: actionName(t),
            note: t.description,
            meta: `decides about ${entityName(t.subject)} · ${Object.keys(t.reasons ?? {}).length} signals · ${
              t.policy?.rules?.length ?? 0
            } rules`,
          }))}
          scratch={
            picking === "start"
              ? {
                  note: "An empty action. You write the question, the signals, the typologies and the policy.",
                  onPick: () => setPicking(null),
                }
              : undefined
          }
          templatesNote="A template fills in the question, the signals, the typologies and the policy. You can change everything before you create the action."
          onPick={(id) => (use(templateList.find((t) => t.name === id)!), setPicking(null))}
          onClose={() => setPicking(null)}
        />
      )}
      {from && (
        <div className="banner info">
          The {actionName(from)} template is filled in below. It was written and tuned on synthetic data: change the
          wording to your product, check that your events carry what each signal needs, and set the thresholds on your
          own outcomes.
        </div>
      )}
      {exists && (
        <div className="banner" style={{ background: "var(--review-soft)", color: "var(--ink)" }}>
          An action with the key <span className="mono">{exists.name}</span> already exists, at version {exists.version}
          . Creating this will save a new version of it. Change the key to keep both.
        </div>
      )}

      <div className="split">
        <div className="stack">
          <Card title="The decision">
            <div className="stack" style={{ gap: 16 }}>
              <div className="pair-fields">
                <label className="field">
                  <span>Name</span>
                  <input
                    className="input"
                    placeholder="Bank Transfer"
                    value={draft.label}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        label: e.target.value,
                        ...(isNew && !keyTouched ? { name: slug(e.target.value) } : {}),
                      })
                    }
                  />
                  <small>What people see in the console.</small>
                </label>
                {isNew ? (
                  <label className="field">
                    <span>Key</span>
                    <input
                      className="input mono"
                      placeholder="bank_transfer"
                      value={draft.name}
                      onChange={(e) => (setKeyTouched(true), set("name", e.target.value))}
                    />
                    <small>What your code passes to decide(). It cannot change later.</small>
                  </label>
                ) : (
                  <div className="field">
                    <span>Key</span>
                    <div className="fixed-value mono">{draft.name}</div>
                    <small>What your code passes to decide(). It cannot change.</small>
                  </div>
                )}
              </div>

              <label className="field">
                <span>Decides about</span>
                <select className="input" value={draft.subject} onChange={(e) => set("subject", e.target.value)}>
                  {subjects.map((type) => (
                    <option key={type} value={type}>
                      {entityName(type)}
                    </option>
                  ))}
                </select>
                <small>The entity whose history is read for the decision.</small>
              </label>

              <div className="field">
                <span>When it runs</span>
                <div className="key-kinds">
                  <button
                    type="button"
                    className={`template ${!startsBy ? "on" : ""}`}
                    onClick={() => (
                      setByEvent(false),
                      setDraft({ ...draft, trigger: "", triggerStatus: "" }),
                      setSaved(null)
                    )}
                  >
                    <b>On request</b>
                    <span>Your server asks Kairos for this decision, for example when a user starts a transfer.</span>
                    <small className="mono">
                      kairos.decide({"{"} type: "{draft.name || "key"}", … {"}"})
                    </small>
                  </button>
                  <button type="button" className={`template ${startsBy ? "on" : ""}`} onClick={() => setByEvent(true)}>
                    <b>On an event</b>
                    <span>
                      The decision is made when your server sends an event of one type. The event is stored too.
                    </span>
                    <small className="mono">kairos.trackAndDecide("{draft.trigger || "event"}", …)</small>
                  </button>
                </div>
              </div>
              {startsBy && (
                <div className="pair-fields">
                  <label className="field">
                    <span>Event</span>
                    <ChoiceSelect
                      mono
                      value={draft.trigger}
                      options={metricOptions?.event_types ?? []}
                      placeholder="Choose an event type"
                      other="Another event type…"
                      onChange={(v) => set("trigger", v)}
                    />
                    <small>Choose an event you send, or another that you will send.</small>
                  </label>
                  <label className="field">
                    <span>Only when its status is</span>
                    <input
                      className="input mono"
                      placeholder="any status"
                      value={draft.triggerStatus}
                      onChange={(e) => set("triggerStatus", e.target.value)}
                    />
                    <small>Optional. One status, or several with commas: pending, disputed.</small>
                  </label>
                </div>
              )}
              {startsBy && (
                <AutomaticField
                  name={existing?.name}
                  trigger={draft.trigger}
                  on={draft.automatic}
                  onChange={(on) => set("automatic", on)}
                />
              )}
              <label className="field">
                <span>Hold question</span>
                <textarea
                  className="input"
                  placeholder="Should the pending transfer be held for manual review because the account shows signs of …?"
                  value={draft.hold}
                  onChange={(e) => set("hold", e.target.value)}
                />
                <small>A yes/no question where yes means "hold this". Its probability is the risk score.</small>
              </label>
            </div>
          </Card>

          <Card title="Signals to report">
            <Pairs
              items={draft.reasons}
              onChange={(v) => set("reasons", v)}
              codeHint="new_device"
              textHint="The current session uses a device that the account did not use before"
            />
            <p className="note" style={{ margin: "12px 0 0" }}>
              Each signal is judged on its own and returned in reasons when present. Write the description so it stands
              alone.
            </p>
          </Card>

          <Card title={`Totals${totals.length ? ` · ${totals.length}` : ""}`}>
            <p className="note" style={{ margin: "0 0 14px" }}>
              Optional. A total adds up a number over the subject's events, for example the deposits of the last 7 days,
              and gives the result to the model. Use one when a signal depends on amounts over more events than the last
              30.
            </p>
            <div className="stack" style={{ gap: 12 }}>
              {totals.map((total, i) => (
                <TotalForm
                  key={i}
                  total={total}
                  eventTypes={eventTypes}
                  onChange={(next) => (setTotals(totals.map((t, j) => (j === i ? next : t))), setSaved(null))}
                  onRemove={() => (setTotals(totals.filter((_, j) => j !== i)), setSaved(null))}
                />
              ))}
              {totals.length < 8 && (
                <div>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => (
                      setTotals([...totals, { name: "", event: "", sum: "", window: "7d" }]),
                      setSaved(null)
                    )}
                  >
                    + Add total
                  </button>
                </div>
              )}
            </div>
          </Card>

          <Card title="Typologies">
            <Pairs
              items={draft.typologies}
              onChange={(v) => set("typologies", v)}
              codeHint="ato"
              textHint="Account takeover: a person other than the account holder controls the account"
            />
            <p className="note" style={{ margin: "12px 0 0" }}>
              Mutually exclusive explanations. Include one for "nothing wrong".
            </p>
          </Card>
        </div>

        <aside className="stack">
          <Card title="Policy">
            <div className="threshold">
              <span className="tick" style={{ left: `${draft.review * 100}%` }}>
                {draft.review.toFixed(2)}
              </span>
              <span className="tick" style={{ left: `${draft.block * 100}%` }}>
                {draft.block.toFixed(2)}
              </span>
              <div className="zone t-approve" style={{ width: `${draft.review * 100}%` }}>
                Approve
              </div>
              <div className="zone t-review" style={{ width: `${Math.max(draft.block - draft.review, 0) * 100}%` }}>
                Review
              </div>
              <div className="zone t-block" style={{ flex: 1 }}>
                Block
              </div>
            </div>
            <div className="stack" style={{ gap: 12 }}>
              <label className="field">
                <span>Review at or above</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={draft.review}
                  onChange={(e) => set("review", Math.min(Number(e.target.value), draft.block))}
                />
              </label>
              <label className="field">
                <span>Block at or above</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={draft.block}
                  onChange={(e) => set("block", Math.max(Number(e.target.value), draft.review))}
                />
              </label>
              <p className="note" style={{ margin: 0 }}>
                Hard cases often score well below 0.5 while still ranking above normal ones. Tune these on your own
                outcomes.
              </p>
            </div>
          </Card>

          <Card title="Rules">
            <div className="stack" style={{ gap: 16 }}>
              {draft.rules.map((rule, i) => (
                <div key={i} className="stack" style={{ gap: 8 }}>
                  <div className="row">
                    <input
                      className="input mono grow"
                      placeholder="rule_id"
                      value={rule.id}
                      onChange={(e) => setRule(i, { id: e.target.value })}
                    />
                    <button
                      className="icon-btn"
                      aria-label="Remove rule"
                      onClick={() =>
                        set(
                          "rules",
                          draft.rules.filter((_, j) => j !== i),
                        )
                      }
                    >
                      ×
                    </button>
                  </div>
                  <div className="note">
                    When all of these signals are present
                    {totals.length > 0 ? " (none is allowed, with a comparison)" : ""}
                  </div>
                  <div className="toggle-list">
                    {codes.length === 0 && <span className="note">Add signals first.</span>}
                    {codes.map((code) => (
                      <button
                        key={code}
                        className={rule.allOf.includes(code) ? "on" : ""}
                        onClick={() =>
                          setRule(i, {
                            allOf: rule.allOf.includes(code)
                              ? rule.allOf.filter((c) => c !== code)
                              : [...rule.allOf, code],
                          })
                        }
                      >
                        {code}
                      </button>
                    ))}
                  </div>
                  {(totals.length > 0 || (rule.when?.length ?? 0) > 0) && (
                    <>
                      <div className="note">And all of these comparisons hold</div>
                      {(rule.when ?? []).map((condition, at) => {
                        const declared = totals.find((t) => t.name === condition.total);
                        const change = (patch: Partial<TotalCondition>) =>
                          setRule(i, { when: rule.when!.map((c, k) => (k === at ? { ...c, ...patch } : c)) });
                        return (
                          <div className="rule-condition" key={at}>
                            <select
                              className="input mono"
                              aria-label="Total"
                              value={condition.total}
                              onChange={(e) => change({ total: e.target.value, is: "sum" })}
                            >
                              {!declared && (
                                <option value={condition.total}>{condition.total || "Choose a total"}</option>
                              )}
                              {totals
                                .filter((t) => t.name)
                                .map((t) => (
                                  <option key={t.name}>{t.name}</option>
                                ))}
                            </select>
                            <select
                              className="input"
                              aria-label="Measure"
                              value={condition.is ?? "sum"}
                              onChange={(e) => change({ is: e.target.value as TotalCondition["is"] })}
                            >
                              <option value="sum">sum</option>
                              <option value="events">number of events</option>
                              {(declared?.usual || condition.is === "times_usual") && (
                                <option value="times_usual">times the usual</option>
                              )}
                              {(declared?.covers || condition.is === "share_covered") && (
                                <option value="share_covered">share of the request</option>
                              )}
                            </select>
                            <select
                              className="input"
                              aria-label="Comparison"
                              value={condition.op}
                              onChange={(e) => change({ op: e.target.value as TotalCondition["op"] })}
                            >
                              <option value=">">is more than</option>
                              <option value=">=">is at least</option>
                              <option value="<">is less than</option>
                              <option value="<=">is at most</option>
                            </select>
                            <input
                              className="input mono"
                              aria-label="Value"
                              type="number"
                              step="any"
                              value={Number.isFinite(condition.value) ? condition.value : ""}
                              onChange={(e) => change({ value: e.target.value === "" ? NaN : Number(e.target.value) })}
                            />
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label="Remove this comparison"
                              onClick={() => setRule(i, { when: rule.when!.filter((_, k) => k !== at) })}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                      <div>
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={!totals.some((t) => t.name)}
                          onClick={() =>
                            setRule(i, {
                              when: [
                                ...(rule.when ?? []),
                                { total: totals.find((t) => t.name)!.name, is: "sum", op: ">", value: 0 },
                              ],
                            })
                          }
                        >
                          + Comparison on a total
                        </button>
                      </div>
                    </>
                  )}
                  <select
                    className="input"
                    value={rule.outcome}
                    onChange={(e) => setRule(i, { outcome: e.target.value as Outcome })}
                  >
                    {OUTCOMES.filter((o) => o !== "approve").map((o) => (
                      <option key={o} value={o}>
                        then at least: {OUTCOME_LABEL[o]}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <div>
                <button
                  className="btn ghost"
                  onClick={() => set("rules", [...draft.rules, { id: "", allOf: [], outcome: "step_up" }])}
                >
                  + Add rule
                </button>
              </div>
            </div>
          </Card>
        </aside>
      </div>
    </>
  );
}
