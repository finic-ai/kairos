import { cronProblem, nextDue, parseCron } from "@kairos/core";
import { useMemo, useState } from "react";
import {
  conditionFields,
  checkAnswers,
  inputsOf,
  RECORD_TRIGGERS,
  TRIGGER_GROUPS,
  TRIGGER_KINDS,
} from "../../lib/workflows";
import type { WorkflowDraft, WorkflowStep } from "../../types/interfaces";
import { ChoiceSelect } from "../ui/ChoiceSelect";
import { Copy } from "../ui/Copy";
import { ConditionBuilder } from "./ConditionBuilder";
import { InputsEditor } from "./InputsEditor";
import { StepIcon } from "./StepIcon";

type Trigger = WorkflowDraft["trigger"];

const ICON = {
  event: "event",
  record: "record",
  manual: "manual",
  scheduled: "scheduled",
  webhook: "webhook",
  decision: "decision",
} as const;

/** Schedules to start from. Each is a cron expression that can be edited after. */
const SCHEDULES: [string, string][] = [
  ["*/15 * * * *", "Every 15 minutes"],
  ["0 * * * *", "Every hour"],
  ["0 9 * * *", "Every day at 09:00"],
  ["0 9 * * 1-5", "Each weekday at 09:00"],
  ["0 9 * * 1", "Each Monday at 09:00"],
  ["0 9 1 * *", "The first day of each month at 09:00"],
];

const HOOK_METHODS = ["POST", "PUT", "GET"];

/** The time zones the browser knows, with UTC and the browser's own zone first. */
function timeZones(): string[] {
  const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const known = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return [...new Set(["UTC", own, ...known])];
}

/** What a record trigger's `when` and its steps can read, for each kind of record. */
const RECORD_READS: Record<string, string> = {
  entity: "trigger.entity (its type, id and properties), and for an update trigger.before, the properties before it",
  event: "trigger.event, or event (its type, entities and properties)",
  decision: "trigger.decision (its action, subject, decision and resolution)",
};

export function TriggerSettings({
  name,
  trigger,
  eventTypes,
  entityTypes,
  actions,
  eventProperties,
  choose = false,
  hook,
  onNewHook,
  steps = [],
  decisionTaken = null,
  onChange,
  onClose,
}: {
  name: string;
  trigger: Trigger;
  eventTypes: string[];
  entityTypes: string[];
  actions: string[];
  eventProperties: string[];
  /** Open on the list of trigger types, as for a new workflow, not on the trigger's settings. */
  choose?: boolean;
  /** The webhook URL of a saved workflow: absent until the workflow is saved. */
  hook?: { hint?: string; live: boolean };
  /** Make a new URL for the webhook trigger. Gives its path, with the token. */
  onNewHook?: () => Promise<string>;
  /** The steps of the draft: a manual trigger says whether a caller can wait for a run. */
  steps?: WorkflowStep[];
  /** For a decision trigger: another workflow that already makes this action's decisions. */
  decisionTaken?: string | null;
  onChange: (trigger: Trigger, tag: string) => void;
  onClose: () => void;
}) {
  const set = (field: string, value: unknown) => {
    const next: Trigger = { ...trigger };
    if (value === undefined || value === "" || value === false) delete next[field];
    else next[field] = value;
    onChange(next, `trigger:${field}`);
  };
  const text = (field: string) =>
    Array.isArray(trigger[field]) ? (trigger[field] as string[]).join(", ") : String(trigger[field] ?? "");
  const kind = TRIGGER_KINDS.find((k) => k.type === trigger.type);
  const [choosing, setChoosing] = useState(choose);
  const [hookPath, setHookPath] = useState<string | null>(null);
  const [hookError, setHookError] = useState<string | null>(null);
  const zones = useMemo(timeZones, []);
  const delay = trigger.type === "manual" ? checkAnswers(steps).delay : null;
  const zone = text("timezone") || "UTC";
  const cron = text("cron").trim();
  const cronError = trigger.type === "scheduled" && cron ? cronProblem(cron) : null;
  const upcoming = useMemo(() => {
    if (trigger.type !== "scheduled" || !cron || cronProblem(cron)) return [];
    const format = new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    return nextDue(parseCron(cron), new Date(), 3, zone).map((d) => format.format(d));
  }, [trigger.type, cron, zone]);

  if (choosing)
    return (
      <div className="wf-panel">
        <div className="wf-panel-head">
          <b>Trigger type</b>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="wf-panel-body">
          {TRIGGER_GROUPS.map((group) => (
            <div key={group} className="wf-palette-group">
              <div className="wf-palette-title">{group}</div>
              {TRIGGER_KINDS.filter((k) => k.group === group).map((k) => (
                <button
                  key={k.type}
                  type="button"
                  className={`wf-palette-item ${trigger.type === k.type ? "chosen" : ""}`}
                  onClick={() => {
                    // Each kind keeps only its own fields.
                    if (trigger.type !== k.type)
                      onChange(
                        k.type === "record"
                          ? { type: "record", record: "entity", on: "created" }
                          : k.type === "decision"
                            ? { type: "decision", action: actions[0] ?? "" }
                            : { type: k.type },
                        "trigger:type",
                      );
                    setChoosing(false);
                  }}
                >
                  <StepIcon icon={ICON[k.type as keyof typeof ICON]} tone="trigger" />
                  <span>
                    <b>{k.label}</b>
                    <small>{k.about}</small>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    );

  const record = String(trigger.record ?? "entity");
  const recordKind = RECORD_TRIGGERS[record] ?? RECORD_TRIGGERS.entity!;
  const fields = conditionFields({ trigger, earlier: [], inLoop: false, eventProperties, entityTypes }, "trigger");
  const condition = (placeholder: string, hint: string) => (
    <div className="field">
      <span>Only when</span>
      <ConditionBuilder
        value={text("when")}
        fields={fields}
        placeholder={placeholder}
        onChange={(cel) => set("when", cel)}
      />
      <small>{hint}</small>
    </div>
  );
  const backfill = (what: string) => (
    <label className="wf-check">
      <input type="checkbox" checked={trigger.backfill === true} onChange={(e) => set("backfill", e.target.checked)} />
      <span>
        <b>Also start on {what} older than one hour</b>
        <small>For a backfill. Off, as for automatic decisions, an import of history starts no runs.</small>
      </span>
    </label>
  );
  const publicEvents = (
    <label className="wf-check">
      <input
        type="checkbox"
        checked={trigger.allowPublic === true}
        onChange={(e) => set("allowPublic", e.target.checked)}
      />
      <span>
        <b>Also start on events sent with a public key</b>
        <small>
          A public key is in your web pages, so anyone can send such events and start this workflow. Leave this off
          unless the steps are safe for that.
        </small>
      </span>
    </label>
  );

  return (
    <div className="wf-panel">
      <div className="wf-panel-head">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setChoosing(true)}
          aria-label="Change the trigger type"
          title="Change the trigger type"
        >
          ‹
        </button>
        <StepIcon icon={ICON[trigger.type as keyof typeof ICON] ?? "trigger"} tone="trigger" />
        <span className="wf-panel-title">
          <b>{kind?.label ?? trigger.type}</b>
          <small>Trigger</small>
        </span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="wf-panel-body">
        {trigger.type === "record" && (
          <>
            <div className="wf-field-row">
              <label className="field">
                <span>Record</span>
                <select
                  className="input"
                  value={record}
                  // Another kind of record has other changes and filters: only the kind and its first change stay.
                  onChange={(e) =>
                    onChange(
                      { type: "record", record: e.target.value, on: RECORD_TRIGGERS[e.target.value]!.changes[0]![0] },
                      "trigger:record",
                    )
                  }
                >
                  {Object.entries(RECORD_TRIGGERS).map(([value, { label }]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>When it</span>
                <select className="input" value={text("on")} onChange={(e) => set("on", e.target.value)}>
                  {recordKind.changes.map(([on, words]) => (
                    <option key={on} value={on}>
                      {words}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {record === "entity" && (
              <label className="field">
                <span>Entity type</span>
                <select className="input mono" value={text("entity")} onChange={(e) => set("entity", e.target.value)}>
                  <option value="">Any entity type</option>
                  {[...new Set([...entityTypes, text("entity")].filter(Boolean))].sort().map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {record === "entity" && trigger.on === "labelled" && (
              <label className="field">
                <span>Label</span>
                <input
                  className="input mono"
                  placeholder="Any label"
                  value={text("label")}
                  onChange={(e) => set("label", e.target.value.trim())}
                />
                <small>Only this label starts a run, such as chargeback.</small>
              </label>
            )}
            {record === "decision" && (
              <label className="field">
                <span>Action</span>
                <select className="input mono" value={text("action")} onChange={(e) => set("action", e.target.value)}>
                  <option value="">Any action</option>
                  {[...new Set([...actions, text("action")].filter(Boolean))].sort().map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {condition(
              record === "entity"
                ? "trigger.entity.properties.tier == 'gold'"
                : record === "decision"
                  ? "trigger.decision.decision.decision == 'block'"
                  : "trigger.event.type == 'withdrawal'",
              `An expression. It and the steps read ${RECORD_READS[record]}.`,
            )}
            {record === "event" && publicEvents}
            {backfill(record === "event" ? "imported events" : "changes")}
          </>
        )}

        {trigger.type === "event" && (
          <>
            <label className="field">
              <span>Event type</span>
              <ChoiceSelect
                mono
                value={text("event")}
                options={eventTypes}
                placeholder="Choose an event type"
                other="Another event type…"
                onChange={(v) => set("event", v)}
              />
              <small>An event that your system sends: one Kairos has seen, or another that it will send.</small>
            </label>
            <label className="field">
              <span>Status</span>
              <input
                className="input"
                placeholder="Any status"
                value={text("status")}
                onChange={(e) => {
                  const items = e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);
                  set("status", items.length > 1 ? items : items[0]);
                }}
              />
              <small>Only events with this status start a run. Separate more than one with commas.</small>
            </label>
            {condition(
              "event.properties.amount >= 1000",
              "An expression on the event. Empty starts a run for each matching event.",
            )}
            {publicEvents}
            {backfill("imported events")}
          </>
        )}

        {trigger.type === "manual" && (
          <>
            <InputsEditor
              inputs={inputsOf(trigger)}
              entityTypes={entityTypes}
              onChange={(inputs) => set("inputs", inputs.length ? inputs : undefined)}
            />
            <p className="muted wf-panel-note">
              Start a run with <b>Run</b> in the header, or with{" "}
              <span className="mono">POST /v1/workflows/{name || ":name"}/runs</span>. With{" "}
              <span className="mono">"wait": true</span>, the answer comes when the run ends, with its output: the value
              of a Return step, or the output of the last step.
            </p>
            {delay ? (
              <div className="wf-problems note">
                The step "{delay.name}" is a delay, so a caller cannot wait for a run. Runs go on in the background.
              </div>
            ) : (
              <p className="muted wf-panel-note">This workflow has no delay: a caller can wait for its runs.</p>
            )}
          </>
        )}

        {trigger.type === "decision" && (
          <>
            <label className="field">
              <span>Action</span>
              <select className="input mono" value={text("action")} onChange={(e) => set("action", e.target.value)}>
                <option value="">Choose an action</option>
                {[...new Set([...actions, text("action")].filter(Boolean))].sort().map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <small>
                <span className="mono">decide()</span> for this action runs this workflow, and its answer is the
                decision. An action has one decision workflow.
              </small>
            </label>
            {decisionTaken && (
              <div className="wf-problems">
                The workflow "{decisionTaken}" makes the decisions of "{text("action")}". Archive it, or choose another
                action, before you publish this one.
              </div>
            )}
            <label className="field">
              <span>Time until the answer</span>
              <input
                className="input"
                type="number"
                min={1}
                max={30}
                placeholder="5"
                value={text("timeout_seconds")}
                onChange={(e) => set("timeout_seconds", e.target.value === "" ? undefined : Number(e.target.value))}
              />
              <small>
                Seconds, from 1 to 30, apart from the model. Without an answer in time, decide() gets an error.
              </small>
            </label>
            <p className="muted wf-panel-note">
              Steps read the request as <span className="mono">trigger.entities</span>,{" "}
              <span className="mono">trigger.properties</span> and <span className="mono">trigger.session</span>. Use{" "}
              <b>Get the model's decision</b> to get the model's view, and end each path with <b>Return</b>, or with{" "}
              <b>Answer</b> to go on after the decision. The answer has an <span className="mono">outcome</span>:
              approve, step_up, review or block. Steps after an Answer read the decision's id as{" "}
              <span className="mono">trigger.decision_id</span>.
            </p>
            <p className="muted wf-panel-note">
              Paused or archived, the action decides as without a workflow. A step that fails before the answer makes
              decide() fail, as a model that cannot answer does.
            </p>
          </>
        )}

        {trigger.type === "scheduled" && (
          <>
            <label className="field">
              <span>Repeat</span>
              <select
                className="input"
                value={SCHEDULES.some(([c]) => c === cron) ? cron : ""}
                onChange={(e) => e.target.value && set("cron", e.target.value)}
              >
                <option value="">Custom</option>
                {SCHEDULES.map(([c, words]) => (
                  <option key={c} value={c}>
                    {words}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Cron</span>
              <input
                className="input mono"
                placeholder="0 9 * * *"
                value={text("cron")}
                onChange={(e) => set("cron", e.target.value)}
              />
              {cronError ? (
                <small className="bad">{cronError}</small>
              ) : (
                <small>Minute, hour, day of month, month and day of week, in the time zone below.</small>
              )}
            </label>
            <label className="field">
              <span>Time zone</span>
              <select
                className="input"
                value={zone}
                onChange={(e) => set("timezone", e.target.value === "UTC" ? "" : e.target.value)}
              >
                {[...new Set([...zones, zone])].map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
            {upcoming.length > 0 && (
              <div className="field">
                <span>Next runs</span>
                <ul className="wf-next-times">
                  {upcoming.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="muted wf-panel-note">
              Runs start when the workflow is published and active. If Kairos was down at a due time, it starts one run
              for the latest time it missed. Steps read <span className="mono">trigger.scheduled_at</span>.
            </p>
          </>
        )}

        {trigger.type === "webhook" && (
          <>
            <div className="field">
              <span>URL</span>
              {!hook ? (
                <small>Save the workflow to make its URL.</small>
              ) : hookPath ? (
                <>
                  <Copy value={`${window.location.origin}${hookPath}`} />
                  <small>Copy it now: Kairos does not show it again. Anyone with it can start this workflow.</small>
                </>
              ) : (
                <div className="wf-field-row">
                  <span className="mono muted wf-hook-hint">
                    {hook.hint ? `/v1/workflow-hooks/wfh_…${hook.hint}` : "No URL yet"}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      (!hook.hint ||
                        window.confirm(
                          "Make a new URL? The current one stops at once; give the new one to the sender.",
                        )) &&
                      onNewHook?.().then(
                        (path) => (setHookPath(path), setHookError(null)),
                        (e: Error) => setHookError(e.message),
                      )
                    }
                  >
                    {hook.hint ? "New URL" : "Make URL"}
                  </button>
                </div>
              )}
              {hookError && <small className="bad">{hookError}</small>}
              {hook && !hook.live && (
                <small>A call to the URL starts a run when a version with this trigger is published and active.</small>
              )}
            </div>
            <label className="field">
              <span>Method</span>
              <select
                className="input"
                value={text("method") || "POST"}
                onChange={(e) => set("method", e.target.value === "POST" ? "" : e.target.value)}
              >
                {HOOK_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <small>A call with another method gets 405.</small>
            </label>
            <label className="field">
              <span>Delivery id header</span>
              <input
                className="input mono"
                placeholder="X-Request-Id"
                value={text("idempotency_header")}
                onChange={(e) => set("idempotency_header", e.target.value.trim())}
              />
              <small>Calls with the same value in this header start one run. Empty: each call starts a run.</small>
            </label>
            <p className="muted wf-panel-note">
              Steps read <span className="mono">trigger.body</span> (JSON, or text),{" "}
              <span className="mono">trigger.headers</span>, <span className="mono">trigger.query</span> and{" "}
              <span className="mono">trigger.method</span>. The body is at most 1 MB. Kairos keeps no Authorization or
              Cookie header.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
