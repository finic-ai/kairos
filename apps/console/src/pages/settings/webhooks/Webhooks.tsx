import { useEffect, useState, FormEvent, ReactNode } from "react";
import { currentWorkspace, webhooks, WEBHOOK_EVENTS } from "../../../api/index";
import type {
  Outcome,
  Webhook,
  WebhookDelivery,
  WebhookEvent,
  WebhookInput,
  WebhookPreset,
  WebhookTestResult,
  Workspace,
} from "../../../types/interfaces";
import { MultiSelect } from "../../../components/ui/MultiSelect";
import { Switch } from "../../../components/ui/Switch";
import { Tab, TabStrip } from "../../../components/ui/TabStrip";
import { SourceDetail, SourceList } from "./WebhookSources";
import { Card } from "../../../components/ui/Card";
import { Copy } from "../../../components/ui/Copy";
import { Group, Row } from "../../../components/ui/Group";
import { Modal } from "../../../components/ui/Modal";
import { Empty, Loading } from "../../../components/ui/states";
import { actionName, dayOf, stamp } from "../../../lib/format";
import { OUTCOME_LABEL, OUTCOMES } from "../../../lib/outcomes";
import { go, href } from "../../../lib/route";
import { useActions, useApi, useQueues, useWebhookPresets } from "../../../hooks/useApi";

function health(w: Webhook): { label: string; tone: string; note?: string } {
  if (!w.enabled)
    return {
      label: "Disabled",
      tone: "warn",
      note: w.disabled_reason ?? "Turned off by an admin.",
    };
  if (w.failing_since)
    return {
      label: "Failing",
      tone: "review",
      note: `Deliveries are failing since ${stamp(w.failing_since)} UTC. Kairos is retrying.`,
    };
  return { label: "Active", tone: "ok" };
}

const STATUS_TONE: Record<string, string> = {
  delivered: "ok",
  pending: "review",
  failed: "warn",
};

function inTime(ts: string): string {
  const ms = Date.parse(ts) - Date.now();
  if (ms <= 30_000) return "now";
  if (ms < 3_600_000) return `in ${Math.round(ms / 60_000)} min`;
  return `in ${Math.round(ms / 3_600_000)} h`;
}

function filterText(w: Webhook): string {
  const f = w.filter ?? {};
  const decisions = (w.events ?? []).some((e) => e.startsWith("decision."));
  const parts = [
    f.actions?.length ? f.actions.join(", ") : null,
    f.outcomes?.length ? f.outcomes.map((o) => OUTCOME_LABEL[o].toLowerCase()).join(" or ") : null,
    f.min_risk_score !== undefined ? `risk ≥ ${f.min_risk_score}` : null,
  ].filter(Boolean);
  const labels = (w.events ?? []).includes("label.created")
    ? f.labels?.length
      ? `labels ${f.labels.join(", ")}`
      : "every label"
    : null;
  const cases = (w.events ?? []).some((e) => e.startsWith("case."))
    ? f.queues?.length
      ? `${f.queues.length} ${f.queues.length === 1 ? "queue" : "queues"}`
      : "every queue"
    : null;
  return [decisions ? (parts.length ? parts.join(" · ") : "every decision") : null, labels, cases]
    .filter(Boolean)
    .join("; ")
    .replace(/^./, (c) => c.toUpperCase());
}

export function WebhooksPage({ workspace, id }: { workspace: Workspace; id?: string }) {
  if (workspace.role === "member")
    return (
      <>
        <h1>Webhooks</h1>
        <div className="card">
          <Empty title="Only owners and admins can manage webhooks">Ask a workspace owner or admin for access.</Empty>
        </div>
      </>
    );
  if (id === "inbound") return <SourceList workspace={workspace} />;
  return id && id !== "outbound" ? <OneWebhook workspace={workspace} id={id} /> : <WebhookList workspace={workspace} />;
}

function OneWebhook({ workspace, id }: { workspace: Workspace; id: string }) {
  const { data, error, refetch: reload } = useApi(["webhook", workspace.id, id], () => webhooks.get(workspace.id, id));
  if (error && !data)
    return (
      <>
        <a className="crumb" href={href("settings", "webhooks")}>
          ← Webhooks
        </a>
        <div className="banner">{error.message}</div>
      </>
    );
  if (!data) return <Loading />;
  return data.direction === "in" ? (
    <SourceDetail workspace={workspace} webhook={data} reload={reload} />
  ) : (
    <WebhookDetail workspace={workspace} id={id} />
  );
}

export function Tabs({ on }: { on: "outbound" | "inbound" }) {
  return (
    <>
      <h1>Webhooks</h1>
      <nav className="tabs">
        <a href={href("settings", "webhooks", "outbound")} className={on === "outbound" ? "on" : ""}>
          Outbound webhooks
        </a>
        <a href={href("settings", "webhooks", "inbound")} className={on === "inbound" ? "on" : ""}>
          Inbound webhooks
        </a>
      </nav>
    </>
  );
}

function WebhookList({ workspace }: { workspace: Workspace }) {
  const {
    data,
    error,
    refetch: reload,
  } = useApi(["webhooks", workspace.id], () => webhooks.list(workspace.id), {
    refetchInterval: 15_000,
  });
  const [creating, setCreating] = useState(false);

  return (
    <>
      <Tabs on="outbound" />
      {error && <div className="banner">{error.message}</div>}
      {data?.unavailable && <div className="banner">{data.unavailable}</div>}
      {data?.warning && <div className="banner">{data.warning}</div>}

      <Group
        title="Endpoints"
        note="Kairos calls these URLs when something happens, such as a decision."
        action={
          <button className="btn primary" onClick={() => setCreating(true)} disabled={!data || !!data.unavailable}>
            Add endpoint
          </button>
        }
      >
        <div className="card table-wrap">
          {!data ? (
            <Loading />
          ) : data.webhooks.length === 0 ? (
            <Empty title="No endpoints yet">
              Add an endpoint to send decisions to your own systems as they happen.
            </Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th className="hide-md">Sends</th>
                  <th>Status</th>
                  <th className="hide-md" style={{ textAlign: "right" }}>
                    Last 24 hours
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.webhooks.map((w) => {
                  const h = health(w);
                  return (
                    <tr key={w.id} className="link" onClick={() => go("settings", "webhooks", w.id)}>
                      <td>
                        <b>{w.name}</b>
                        <div className="muted mono wh-url">{w.url}</div>
                      </td>
                      <td className="hide-md">
                        <div className="chips">
                          {(w.events ?? []).map((e) => (
                            <span key={e} className="chip">
                              {e}
                            </span>
                          ))}
                        </div>
                        <div className="muted">{filterText(w)}</div>
                      </td>
                      <td>
                        <span className={`chip ${h.tone}`}>{h.label}</span>
                      </td>
                      <td className="hide-md mono" style={{ textAlign: "right" }}>
                        {w.deliveries_24h ?? 0}
                        {(w.failures_24h ?? 0) > 0 && <div className="wh-failed">{w.failures_24h} failed</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Group>

      {creating && (
        <WebhookForm
          workspace={workspace}
          onClose={() => setCreating(false)}
          onSaved={(w) => (reload(), go("settings", "webhooks", w.id))}
        />
      )}
    </>
  );
}

function AllOrCustom({ label, all, onAll }: { label: string; all: boolean; onAll: (all: boolean) => void }) {
  return (
    <div className="seg compact" role="radiogroup" aria-label={label}>
      <button type="button" role="radio" aria-checked={all} className={all ? "on" : ""} onClick={() => onAll(true)}>
        All
      </button>
      <button type="button" role="radio" aria-checked={!all} className={all ? "" : "on"} onClick={() => onAll(false)}>
        Custom
      </button>
    </div>
  );
}

function FilterRow({
  title,
  of,
  all,
  onAll,
  note,
  children,
}: {
  title: string;
  /** The events it filters, such as "Decisions". */
  of: string;
  all?: boolean;
  onAll?: (all: boolean) => void;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <div className="endpoint-filter">
      <div className="endpoint-filter-name">
        <b>{title}</b>
        <small>{of}</small>
      </div>
      <div className="endpoint-filter-control">
        {onAll && <AllOrCustom label={title} all={!!all} onAll={onAll} />}
        {(!onAll || !all) && children}
        {note && <small>{note}</small>}
      </div>
    </div>
  );
}

/** The labels that Kairos and the inbound templates make, for suggestions. Any other label can be typed. */
function knownLabels(presets: WebhookPreset[]): string[] {
  const found = new Set(["fraud_confirmed", "cleared"]);
  for (const p of presets)
    for (const rule of p.mapping.rules) {
      const label = rule.label?.label;
      if (typeof label === "string" && !label.startsWith("$")) found.add(label);
      else if (label && typeof label === "object" && "values" in label)
        for (const v of Object.values(label.values ?? {})) if (typeof v === "string") found.add(v);
    }
  return [...found].sort();
}

function WebhookForm({
  workspace,
  webhook,
  onClose,
  onSaved,
}: {
  workspace: Workspace;
  webhook?: Webhook;
  onClose: () => void;
  onSaved: (w: Webhook) => void;
}) {
  const allEvents = WEBHOOK_EVENTS.map((e) => e.id);
  const [name, setName] = useState(webhook?.name ?? "");
  const [url, setUrl] = useState(webhook?.url ?? "");
  const [allOfEvents, setAllOfEvents] = useState(!webhook || allEvents.every((e) => webhook.events?.includes(e)));
  const [chosenEvents, setChosenEvents] = useState<WebhookEvent[]>(webhook?.events ?? []);
  const events = allOfEvents ? allEvents : chosenEvents;
  const wantsDecisions = events.some((e) => e.startsWith("decision."));
  const wantsLabels = events.includes("label.created");
  const wantsCases = events.some((e) => e.startsWith("case."));
  const filter = webhook?.filter ?? {};
  const [actions, setActions] = useState(filter.actions ?? []);
  const [allActions, setAllActions] = useState(!filter.actions?.length);
  const [outcomes, setOutcomes] = useState<Outcome[]>(filter.outcomes ?? []);
  const [allOutcomes, setAllOutcomes] = useState(!filter.outcomes?.length);
  const [minRisk, setMinRisk] = useState(filter.min_risk_score?.toString() ?? "");
  const [labels, setLabels] = useState(filter.labels ?? []);
  const [allLabels, setAllLabels] = useState(!filter.labels?.length);
  const [queueIds, setQueueIds] = useState(filter.queues ?? []);
  const [allQueues, setAllQueues] = useState(!filter.queues?.length);
  const [properties, setProperties] = useState(webhook?.include_properties ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{
    webhook: Webhook;
    secret: string;
  } | null>(null);
  const { data: known } = useActions();
  const { data: queueList } = useQueues();
  const { data: presets } = useWebhookPresets();

  // "Custom" with nothing chosen would mean nothing at all: the form asks for a choice, or All.
  const missing = [
    !allOfEvents && chosenEvents.length === 0 && "an event",
    wantsDecisions && !allActions && actions.length === 0 && "an action",
    wantsDecisions && !allOutcomes && outcomes.length === 0 && "an outcome",
    wantsLabels && !allLabels && labels.length === 0 && "a label",
    wantsCases && !allQueues && queueIds.length === 0 && "a queue",
  ].filter(Boolean);

  // The filters in use, for the summary on the closed section.
  const used = [
    wantsDecisions && !allActions && "actions",
    wantsDecisions && !allOutcomes && "outcomes",
    wantsDecisions && minRisk.trim() && `risk ${minRisk.trim()}+`,
    wantsLabels && !allLabels && "labels",
    wantsCases && !allQueues && "queues",
  ].filter(Boolean) as string[];
  const [filtersOpen, setFiltersOpen] = useState(used.length > 0);
  const filtersSummary = filtersOpen
    ? "Optional. Only the events that match are sent."
    : used.length
      ? `Filtered by ${used.join(", ")}`
      : "None: every event chosen above is sent.";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const input: WebhookInput = {
      name: name.trim(),
      url: url.trim(),
      events,
      filter: {
        ...(wantsDecisions && !allActions ? { actions } : {}),
        ...(wantsDecisions && !allOutcomes ? { outcomes } : {}),
        ...(wantsDecisions && minRisk.trim() ? { min_risk_score: Number(minRisk) } : {}),
        ...(wantsLabels && !allLabels ? { labels } : {}),
        ...(wantsCases && !allQueues ? { queues: queueIds } : {}),
      },
      include_properties: properties,
    };
    try {
      if (webhook) onSaved(await webhooks.update(workspace.id, webhook.id, input));
      else setCreated(await webhooks.create(workspace.id, input));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (created)
    return (
      <SecretShown
        title="Endpoint added"
        secret={created.secret}
        webhook={created.webhook}
        workspace={workspace}
        onDone={() => onSaved(created.webhook)}
      />
    );

  return (
    <Modal title={webhook ? "Edit endpoint" : "Add endpoint"} onClose={onClose} className="endpoint-modal">
      <form className="endpoint-form" onSubmit={submit}>
        {error && <div className="banner endpoint-error">{error}</div>}

        <section className="form-section">
          <h3>Endpoint</h3>
          <label className="field">
            <span>Name</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Fraud review queue"
              maxLength={100}
              required
              autoFocus
            />
          </label>
          <label className="field">
            <span>URL</span>
            <input
              className="input mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://api.example.com/kairos/webhooks"
              required
            />
            <small>Must be https:// and reachable from the internet.</small>
          </label>
        </section>

        <section className="form-section">
          <div className="form-section-head">
            <h3>Events</h3>
            <AllOrCustom label="Events" all={allOfEvents} onAll={setAllOfEvents} />
          </div>
          {allOfEvents ? (
            <p className="note">Every event that Kairos sends now: decisions, labels and cases.</p>
          ) : (
            <MultiSelect
              label="Events"
              mono
              value={chosenEvents}
              onChange={(v) => setChosenEvents(v as WebhookEvent[])}
              options={WEBHOOK_EVENTS.map((e) => ({ value: e.id, label: e.id, note: e.note }))}
              placeholder="Search events, or press ↓ to see them all"
            />
          )}
        </section>

        {(wantsDecisions || wantsLabels || wantsCases) && (
          <section className="form-section">
            <button
              type="button"
              className={`form-section-toggle${filtersOpen ? " open" : ""}`}
              aria-expanded={filtersOpen}
              aria-controls="endpoint-filters"
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              <span className="form-section-title">
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="m8 5 5 5-5 5" />
                </svg>
                Filters
                {!filtersOpen && used.length > 0 && <span className="count">{used.length}</span>}
              </span>
              <small>{filtersSummary}</small>
            </button>
            <div className="endpoint-filters" id="endpoint-filters" hidden={!filtersOpen}>
              {wantsDecisions && (
                <>
                  <FilterRow title="Actions" of="Decisions" all={allActions} onAll={setAllActions}>
                    <MultiSelect
                      label="Actions"
                      value={actions}
                      onChange={setActions}
                      options={(known?.actions ?? []).map((a) => ({
                        value: a.name,
                        label: actionName(a),
                        note: a.name !== actionName(a) ? a.name : undefined,
                      }))}
                      placeholder={known && known.actions.length === 0 ? "No actions yet" : "Search actions…"}
                    />
                  </FilterRow>
                  <FilterRow
                    title="Outcomes"
                    of="Decisions"
                    all={allOutcomes}
                    onAll={setAllOutcomes}
                    note={allOutcomes ? undefined : "For decision.updated, the outcome after the person's resolution."}
                  >
                    <MultiSelect
                      label="Outcomes"
                      value={outcomes}
                      onChange={(v) => setOutcomes(v as Outcome[])}
                      options={OUTCOMES.map((o) => ({ value: o, label: OUTCOME_LABEL[o] }))}
                      placeholder="Search outcomes…"
                    />
                  </FilterRow>
                  <FilterRow title="Risk score" of="Decisions">
                    <div className="risk-field">
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={minRisk}
                        onChange={(e) => setMinRisk(e.target.value)}
                        placeholder="Any"
                        aria-label="Minimum risk score"
                      />
                      <span className="muted">or higher, from 0 to 100</span>
                    </div>
                  </FilterRow>
                </>
              )}
              {wantsLabels && (
                <FilterRow
                  title="Labels"
                  of="label.created"
                  all={allLabels}
                  onAll={setAllLabels}
                  note={allLabels ? undefined : "Type a label that is not in the list, and press Enter."}
                >
                  <MultiSelect
                    label="Labels"
                    mono
                    custom
                    value={labels}
                    onChange={setLabels}
                    options={knownLabels(presets?.presets ?? []).map((l) => ({ value: l, label: l }))}
                    placeholder="chargeback, fraud_confirmed…"
                  />
                </FilterRow>
              )}
              {wantsCases && (
                <FilterRow title="Queues" of="Cases" all={allQueues} onAll={setAllQueues}>
                  <MultiSelect
                    label="Queues"
                    value={queueIds}
                    onChange={setQueueIds}
                    options={(queueList?.queues ?? []).map((q) => ({ value: q.id, label: q.name }))}
                    placeholder="Search queues…"
                  />
                </FilterRow>
              )}
            </div>
          </section>
        )}

        <section className="form-section">
          <h3>Payload</h3>
          <div className="payload-option">
            <Switch checked={properties} onChange={setProperties} label="Include the request's properties" />
            <small>
              Turn off when the receiver must not hold personal data. The ids of the entities are always sent.
            </small>
          </div>
        </section>

        <div className="modal-foot endpoint-foot">
          {missing.length > 0 && <small className="note">Choose {missing.join(", ")}, or select All.</small>}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving || events.length === 0 || missing.length > 0}>
            {saving ? "Saving…" : webhook ? "Save" : "Add endpoint"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A new signing secret, shown once, with a test send so the receiver can be checked at once. */
function SecretShown({
  title,
  secret,
  webhook,
  workspace,
  onDone,
  note,
}: {
  title: string;
  secret: string;
  webhook: Webhook;
  workspace: Workspace;
  onDone: () => void;
  note?: string;
}) {
  return (
    <Modal title={title} onClose={onDone}>
      <div className="modal-body">
        <p>
          This is the signing secret of <b>{webhook.name}</b>. Your receiver needs it to check that a message came from
          Kairos. Store it with your other secrets: you won't see it again.
        </p>
        <Copy value={secret} />
        {note && <p className="note">{note}</p>}
        <p className="note">
          Check each message with <span className="mono">verifyWebhook</span> (TypeScript) or{" "}
          <span className="mono">verify_webhook</span> (Python) from the Kairos SDK, or any Standard Webhooks library.
        </p>
        <TestButton workspace={workspace} webhook={webhook} />
        <div className="modal-foot">
          <button className="btn primary" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TestButton({ workspace, webhook, onSent }: { workspace: Workspace; webhook: Webhook; onSent?: () => void }) {
  const [result, setResult] = useState<WebhookTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const send = () => {
    setSending(true);
    setError(null);
    webhooks
      .test(workspace.id, webhook.id)
      .then(
        (r) => (setResult(r), onSent?.()),
        (e: Error) => setError(e.message),
      )
      .finally(() => setSending(false));
  };
  return (
    <div className="wh-test">
      <button type="button" className="btn" onClick={send} disabled={sending}>
        {sending ? "Sending…" : "Send test message"}
      </button>
      {error && <span className="wh-failed">{error}</span>}
      {result &&
        (result.delivered ? (
          <span className="wh-ok">
            Delivered · {result.status} in {result.ms} ms
          </span>
        ) : (
          <span className="wh-failed">Failed · {result.problem}</span>
        ))}
    </div>
  );
}

const LOG_FILTERS = [
  ["", "All"],
  ["failed", "Failed"],
  ["pending", "Retrying"],
  ["delivered", "Delivered"],
] as const;
const PAGE = 50;

function WebhookDetail({ workspace, id }: { workspace: Workspace; id: string }) {
  const {
    data: webhook,
    error: loadError,
    refetch: reload,
  } = useApi(["webhook", workspace.id, id], () => webhooks.get(workspace.id, id), { refetchInterval: 15_000 });
  const [status, setStatus] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const { data: log, refetch: reloadLog } = useApi(
    ["webhook-deliveries", workspace.id, id, status, limit],
    () => webhooks.deliveries(workspace.id, id, { status: status || undefined, limit }),
    { refetchInterval: 5_000 },
  );
  const [editing, setEditing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotated, setRotated] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = <T,>(work: Promise<T>, done?: string | ((result: T) => string | null)) =>
    work.then(
      (result) => (
        setError(null),
        setNotice(typeof done === "function" ? done(result) : (done ?? null)),
        reload(),
        reloadLog()
      ),
      (e: Error) => setError(e.message),
    );

  if (loadError && !webhook)
    return (
      <>
        <a className="crumb" href={href("settings", "webhooks", "outbound")}>
          ← Outbound webhooks
        </a>
        <div className="banner">{loadError.message}</div>
      </>
    );
  if (!webhook) return <Loading />;
  const h = health(webhook);
  const overlapping = webhook.secret_hints.length > 1;
  const failed = log?.deliveries.filter((d) => d.status === "failed").length ?? 0;

  return (
    <>
      <a className="crumb" href={href("settings", "webhooks", "outbound")}>
        ← Outbound webhooks
      </a>
      <div className="wh-head">
        <div>
          <h1>{webhook.name}</h1>
          <div className="mono muted wh-url">{webhook.url}</div>
        </div>
        <span className={`chip ${h.tone}`}>{h.label}</span>
      </div>
      {error && <div className="banner">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
      {h.note && webhook.enabled === false && (
        <div className="banner">{h.note} Enable it to send the deliveries that are waiting.</div>
      )}
      {h.note && webhook.enabled && <div className="banner">{h.note}</div>}

      <Group
        title="Endpoint"
        action={
          <div className="row">
            <button className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              className="btn"
              onClick={() =>
                run(
                  webhooks.update(workspace.id, webhook.id, {
                    enabled: !webhook.enabled,
                  }),
                  webhook.enabled ? "Endpoint disabled. New events are not sent to it." : "Endpoint enabled.",
                )
              }
            >
              {webhook.enabled ? "Disable" : "Enable"}
            </button>
          </div>
        }
      >
        <div className="card rows">
          <Row title="Events">
            <div className="chips">
              {(webhook.events ?? []).map((e) => (
                <span key={e} className="chip">
                  {e}
                </span>
              ))}
            </div>
          </Row>
          <Row title="Sends" note="The filters of this endpoint.">
            <span>{filterText(webhook)}</span>
          </Row>
          <Row title="Request properties">
            <span className="muted">{webhook.include_properties ? "Included" : "Left out"}</span>
          </Row>
          <Row title="Test" note="Sends a webhook.test message now. It is not retried.">
            <TestButton workspace={workspace} webhook={webhook} onSent={reloadLog} />
          </Row>
          <Row title="Created">
            <span className="muted">{dayOf(webhook.created)}</span>
          </Row>
        </div>
      </Group>

      <Group
        title="Signing secret"
        note="Each message is signed with it, as Standard Webhooks does. After a rotation, the old and the new secret both sign for 24 hours."
      >
        <div className="card rows">
          {webhook.secret_hints.map((s) => (
            <Row
              key={s.hint}
              title={s.expires ? "Old secret" : "Current secret"}
              note={s.expires ? `Stops signing ${stamp(s.expires)} UTC.` : `Made ${stamp(s.added)} UTC.`}
            >
              <span className="mono">{s.hint}</span>
            </Row>
          ))}
          <Row
            title=""
            note={
              overlapping
                ? "Stop the old secret when your receiver uses the new one, or at once if it leaked."
                : undefined
            }
          >
            <div className="row">
              {overlapping && (
                <button
                  className="btn"
                  onClick={() =>
                    window.confirm(
                      "Stop signing with the old secret now? Receivers that still use it will refuse the messages.",
                    ) && run(webhooks.endOverlap(workspace.id, webhook.id), "The old secret no longer signs.")
                  }
                >
                  Stop old secret now
                </button>
              )}
              <button className="btn" onClick={() => setRotating(true)}>
                Rotate secret
              </button>
            </div>
          </Row>
        </div>
      </Group>

      <Group title="Deliveries" note="The last 30 days. A message keeps its id on every attempt and resend.">
        <div className="log-toolbar">
          <TabStrip label="Delivery status">
            {LOG_FILTERS.map(([value, label]) => (
              <Tab key={value} on={status === value} onSelect={() => (setStatus(value), setLimit(PAGE))}>
                {label}
              </Tab>
            ))}
          </TabStrip>
          {status === "failed" && failed > 0 && (
            <button
              className="btn"
              onClick={() =>
                run(
                  webhooks.resend(workspace.id, webhook.id, {
                    status: "failed",
                  }),
                  (r) => `${r.queued} ${r.queued === 1 ? "delivery" : "deliveries"} queued to send again.`,
                )
              }
            >
              Resend all failed
            </button>
          )}
        </div>
        <div className="card table-wrap">
          {!log ? (
            <Loading />
          ) : log.deliveries.length === 0 ? (
            <Empty title={status ? "No deliveries with this status" : "No deliveries yet"}>
              {status ? null : "Make a decision, or send a test message."}
            </Empty>
          ) : (
            <table className="wh-log">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Status</th>
                  <th className="hide-md">Attempts</th>
                  <th className="hide-md">Answer</th>
                </tr>
              </thead>
              <tbody>
                {log.deliveries.map((d) => (
                  <tr key={d.id} className="link" onClick={() => setOpened(d.id)}>
                    <td className="mono">{stamp(d.created)}</td>
                    <td>
                      <span className="mono">{d.type}</span>
                      {d.subject_ref?.startsWith("decision:") && (
                        <div className="muted mono wh-id">{d.subject_ref.slice(9)}</div>
                      )}
                    </td>
                    <td>
                      <DeliveryStatus d={d} />
                    </td>
                    <td className="hide-md mono">{d.attempts}</td>
                    <td className="hide-md">
                      <Answer d={d} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {log?.next_offset && (
          <button className="btn ghost usage-more" onClick={() => setLimit(limit + PAGE)}>
            Show more
          </button>
        )}
      </Group>

      <Group title="Danger zone">
        <div className="card rows danger">
          <Row title="Delete endpoint" note="Kairos stops sending to it at once. Its delivery log is deleted too.">
            <button
              className="btn danger"
              onClick={() =>
                window.confirm(`Delete "${webhook.name}" and its delivery log?`) &&
                webhooks.remove(workspace.id, webhook.id).then(
                  () => go("settings", "webhooks", "outbound"),
                  (e: Error) => setError(e.message),
                )
              }
            >
              Delete endpoint
            </button>
          </Row>
        </div>
      </Group>

      {editing && (
        <WebhookForm
          workspace={workspace}
          webhook={webhook}
          onClose={() => setEditing(false)}
          onSaved={() => (setEditing(false), setNotice("Endpoint saved."), reload())}
        />
      )}
      {rotating && (
        <Modal title="Rotate signing secret" onClose={() => setRotating(false)}>
          <div className="modal-body">
            <p>
              Kairos makes a new secret. For 24 hours, each message carries two signatures: one with the old secret and
              one with the new. Put the new secret in your receiver within that time.
            </p>
            <div className="modal-foot">
              <button className="btn" onClick={() => setRotating(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => (
                  setRotating(false),
                  run(webhooks.rotate(workspace.id, webhook.id).then((r) => setRotated(r.secret)))
                )}
              >
                Rotate secret
              </button>
            </div>
          </div>
        </Modal>
      )}
      {rotated && (
        <SecretShown
          title="New signing secret"
          secret={rotated}
          webhook={webhook}
          workspace={workspace}
          onDone={() => (setRotated(null), reloadLog())}
        />
      )}
      {opened && (
        <DeliveryModal
          workspace={workspace}
          webhook={webhook}
          id={opened}
          onClose={() => setOpened(null)}
          onResent={() => (setOpened(null), setNotice("Queued to send again."), reloadLog())}
        />
      )}
    </>
  );
}

/**
 * Only admins can read the log, so for everyone else, and for a decision that no webhook wanted, it shows nothing.
 */
export function DecisionDeliveries({ decisionId }: { decisionId: string }) {
  const workspace = currentWorkspace();
  const [pending, setPending] = useState(false);
  const { data } = useApi(
    ["webhook-deliveries-about", workspace, decisionId],
    () =>
      workspace
        ? webhooks.about(workspace, `decision:${decisionId}`).catch(() => ({ deliveries: [] }))
        : Promise.resolve({ deliveries: [] }),
    { refetchInterval: pending ? 3_000 : undefined },
  );
  useEffect(() => setPending(!!data?.deliveries.some((d) => d.status === "pending")), [data]);
  if (!data || data.deliveries.length === 0) return null;
  return (
    <Card title="Webhooks" className="o-webhooks">
      <div className="wh-about">
        {data.deliveries.map((d) => (
          <a key={d.id} href={href("settings", "webhooks", d.webhook_id)}>
            <span>
              <b>{d.webhook_name}</b>
              <small className="mono">
                {d.type} · {d.response_status ? `${d.response_status} · ` : ""}
                {d.attempts} {d.attempts === 1 ? "attempt" : "attempts"}
              </small>
            </span>
            <span>
              <DeliveryStatus d={d} />
            </span>
          </a>
        ))}
      </div>
    </Card>
  );
}

export function DeliveryStatus({ d }: { d: WebhookDelivery }) {
  const label =
    d.status === "pending"
      ? d.attempts === 0
        ? "Sending"
        : "Retrying"
      : d.status === "delivered"
        ? "Delivered"
        : d.status === "failed"
          ? "Failed"
          : d.status;
  return (
    <>
      <span className={`chip ${STATUS_TONE[d.status] ?? ""}`}>{label}</span>
      {d.status === "pending" && d.attempts > 0 && d.next_attempt && (
        <div className="muted">next {inTime(d.next_attempt)}</div>
      )}
    </>
  );
}

function Answer({ d }: { d: WebhookDelivery }) {
  if (d.status === "delivered")
    return (
      <span className="mono">
        {d.response_status} · {d.response_ms} ms
      </span>
    );
  if (d.problem) return <span className="wh-failed">{d.problem}</span>;
  return <span className="muted">—</span>;
}

function DeliveryModal({
  workspace,
  webhook,
  id,
  onClose,
  onResent,
}: {
  workspace: Workspace;
  webhook: Webhook;
  id: string;
  onClose: () => void;
  onResent: () => void;
}) {
  const { data, error } = useApi(["webhook-delivery", workspace.id, webhook.id, id], () =>
    webhooks.delivery(workspace.id, webhook.id, id),
  );
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => setFailed(null), [id]);
  return (
    <Modal title="Delivery" onClose={onClose} wide>
      <div className="modal-body">
        {(error ?? failed) && (
          <div className="banner" style={{ margin: 0 }}>
            {error?.message ?? failed}
          </div>
        )}
        {!data ? (
          <Loading />
        ) : (
          <>
            <div className="wh-facts">
              <div>
                <span>Status</span>
                <DeliveryStatus d={data} />
              </div>
              <div>
                <span>Event</span>
                <b className="mono">{data.type}</b>
              </div>
              <div>
                <span>Message id</span>
                <b className="mono">{data.external_id}</b>
              </div>
              <div>
                <span>Attempts</span>
                <b className="mono">{data.attempts}</b>
              </div>
              <div>
                <span>Made</span>
                <b className="mono">{stamp(data.created)} UTC</b>
              </div>
              {data.finished && (
                <div>
                  <span>{data.status === "delivered" ? "Delivered" : "Ended"}</span>
                  <b className="mono">{stamp(data.finished)} UTC</b>
                </div>
              )}
            </div>
            {data.subject_ref?.startsWith("decision:") && (
              <p>
                About decision{" "}
                <a className="mono" href={href("decisions", data.subject_ref.slice(9))}>
                  {data.subject_ref.slice(9)}
                </a>
              </p>
            )}
            {data.problem && (
              <div className="banner" style={{ margin: 0 }}>
                Last attempt: {data.problem}
              </div>
            )}
            <div className="wh-pre">
              <h3>Body</h3>
              <pre>{JSON.stringify(data.payload, null, 2)}</pre>
            </div>
            {data.headers && (
              <div className="wh-pre">
                <h3>Headers of the last attempt</h3>
                <pre>
                  {Object.entries(data.headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join("\n")}
                </pre>
              </div>
            )}
            {data.response_status !== null && (
              <div className="wh-pre">
                <h3>Answer · {data.response_status}</h3>
                <pre>{data.response_body || "(empty)"}</pre>
              </div>
            )}
            <div className="modal-foot">
              <button className="btn" onClick={onClose}>
                Close
              </button>
              {data.status !== "pending" && (
                <button
                  className="btn primary"
                  onClick={() =>
                    webhooks
                      .resend(workspace.id, webhook.id, { delivery: data.id })
                      .then(onResent, (e: Error) => setFailed(e.message))
                  }
                >
                  Resend
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
