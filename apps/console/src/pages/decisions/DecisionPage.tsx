import { useState } from "react";
import { api, workflows } from "../../api/index";
import { ActionRef } from "../../components/actions/ActionRef";
import { DecisionSkeleton } from "../../components/decisions/DecisionSkeleton";
import { WorkflowSignals } from "../../components/decisions/WorkflowSignals";
import { WorkflowTrace } from "../../components/decisions/WorkflowTrace";
import { LabelShares } from "../../components/decisions/LabelShares";
import { Gauge, Pill } from "../../components/decisions/Outcome";
import { ResolutionCard } from "../../components/decisions/ResolutionCard";
import { Timeline } from "../../components/events/Timeline";
import { Card } from "../../components/ui/Card";
import { Chips } from "../../components/ui/Chips";
import { KV } from "../../components/ui/KV";
import { Failure } from "../../components/ui/states";
import { useActionNames } from "../../hooks/useActionNames";
import { useApi } from "../../hooks/useApi";
import { useEntityTypes } from "../../hooks/useEntityTypes";
import { entityName, stamp, triggerText } from "../../lib/format";
import { slugOfRef } from "../../lib/models";
import { href } from "../../lib/route";
import type { DecisionModelScore } from "../../types/interfaces";
import { DecisionDeliveries } from "../settings/webhooks/Webhooks";

const HEADLINE = {
  approve: "Approved without intervention",
  step_up: "Stepped up for more information",
  review: "Sent to manual review",
  block: "Blocked by policy",
};

function totalText(value: unknown): string {
  if (value === null) return "not known";
  if (typeof value !== "object") return typeof value === "number" ? value.toLocaleString() : String(value);
  const { sum, events, ...rest } = value as { sum?: number; events?: number } & Record<string, unknown>;
  const groups = Object.entries(rest).map(
    ([key, part]) =>
      `${key.replaceAll("_", " ")}: ${
        typeof part === "object" && part
          ? Object.entries(part)
              .map(([k, v]) => `${k} ${Number(v).toLocaleString()}`)
              .join(", ")
          : String(part)
      }`,
  );
  return [`${(sum ?? 0).toLocaleString()} from ${events ?? 0} ${events === 1 ? "event" : "events"}`, ...groups].join(
    " · ",
  );
}

export function DecisionPage({ id }: { id: string }) {
  const names = useActionNames();
  const { data: d, error, refetch: reload } = useApi(["decision", id], () => api.decision(id));
  const actionName = d?.action.split("@")[0];
  const { data: action } = useApi(["action", actionName], () => api.action(actionName!), { enabled: !!actionName });
  const [feedback, setFeedback] = useState<string | null>(null);
  const entityTypes = useEntityTypes();
  const runId = typeof d?.metadata?.decision_run_id === "string" ? d.metadata.decision_run_id : null;
  const { data: run } = useApi(["workflow-run", runId], () => workflows.run(runId!).catch(() => null), {
    enabled: !!runId,
  });
  const ran = run?.workflow ?? "";
  const ranName = ran.slice(0, ran.lastIndexOf("@"));
  const ranVersion = Number(ran.split("@").at(-1));
  const { data: ranDefinition } = useApi(
    ["workflow", ranName, ranVersion],
    () => workflows.get(ranName, ranVersion).catch(() => null),
    { enabled: !!ranName && ranVersion > 0 },
  );

  if (error) return <Failure message={error.message} />;
  if (!d) return <DecisionSkeleton />;

  const outcome = d.decision.decision;
  const threshold = action?.context?.reasonThreshold ?? 0.5;
  // A decision workflow that decided without the model keeps no model input or answer.
  const asked = !!d.raw?.answers;
  const workflow = typeof d.metadata?.decision_workflow === "string" ? d.metadata.decision_workflow : null;
  const workflowRun = typeof d.metadata?.decision_run_id === "string" ? d.metadata.decision_run_id : null;
  const signals = Object.entries(d.raw?.answers?.reasons?.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
  const typology = d.raw?.answers?.typology;
  const baseline = asked ? d.context.baseline_of_older_events : undefined;
  const links = Object.entries((asked && d.context.linked_entities) || {});
  const scores = Array.isArray(d.metadata?.scores) ? (d.metadata.scores as DecisionModelScore[]) : [];
  const traced = run && ranDefinition ? { run, definition: ranDefinition } : null;

  const label = async (name: string) => {
    await api.label(d.subject, name, { decision_id: d.id });
    setFeedback(name);
  };

  return (
    <div className={`t-${outcome}`}>
      <a className="crumb" href={href("decisions")}>
        ← Decisions
      </a>

      <div className="split detail">
        <div className="stack">
          <section className="card hero o-hero">
            <Gauge value={d.decision.risk_score} outcome={outcome} />
            <div>
              <Pill outcome={outcome} large />
              <h1>{HEADLINE[outcome]}</h1>
              {d.resolution && (
                <div className="resolved-line">
                  Then {d.resolution.outcome === "approve" ? "approved" : "blocked"} by {d.resolution.by} ·{" "}
                  {stamp(d.resolution.at)} UTC
                </div>
              )}
              <div className="meta">
                <span>
                  {entityName(d.subject.type)}{" "}
                  <a className="mono linkish" href={href("entities", d.subject.type, d.subject.id)}>
                    {d.subject.id}
                  </a>
                </span>
                <span>
                  action{" "}
                  <a href={href("actions", actionName ?? "")}>
                    <ActionRef action={d.action} names={names} />
                  </a>
                </span>
                <span className="mono">{stamp(d.ts)} UTC</span>
                {d.event_id && action?.trigger && (
                  <span>
                    started by event <span className="mono">{triggerText(action.trigger)}</span>
                  </span>
                )}
                {d.automatic && <span>decided automatically</span>}
                {workflow && (
                  <span>
                    decided by workflow{" "}
                    {workflowRun ? (
                      <a className="mono" href={href("workflow-runs", workflowRun)}>
                        {workflow}
                      </a>
                    ) : (
                      <span className="mono">{workflow}</span>
                    )}
                  </span>
                )}
                {d.session && (
                  <span>
                    in session{" "}
                    <a className="mono" href={href("sessions", d.session)}>
                      {d.session}
                    </a>
                  </span>
                )}
              </div>
              {d.decision.rules.length > 0 && (
                <div className="row wrap" style={{ marginTop: 14 }}>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    Policy rule fired
                  </span>
                  <Chips items={d.decision.rules} tone="accent" max={5} />
                </div>
              )}
            </div>
          </section>

          {traced && (
            <WorkflowSignals
              run={traced.run}
              steps={traced.definition.steps}
              decision={{
                action: d.action,
                signals,
                descriptions: action?.reasons,
                threshold,
                policy: action?.policy?.rules,
              }}
            />
          )}

          {traced && (
            <Card title="How the workflow decided" className="o-trace">
              <WorkflowTrace
                run={traced.run}
                definition={traced.definition}
                outcome={outcome}
                entityTypes={entityTypes}
                decision={
                  asked
                    ? { action: d.action, events: d.context.recent_events, pending: d.context.pending_action, signals }
                    : undefined
                }
              />
              <p className="note" style={{ margin: "14px 0 0" }}>
                The steps of <span className="mono">{workflow}</span> in order, with what each one read and gave.{" "}
                {workflowRun && <a href={href("workflow-runs", workflowRun)}>See the run on its canvas</a>}
              </p>
            </Card>
          )}

          {!traced && signals.length > 0 && (
            <Card title="Signals" className="o-signals">
              {signals.map(([code, p]) => (
                <div key={code} className={`signal ${p >= threshold ? "on" : ""}`}>
                  <span className="dot" />
                  <div>
                    <div className="name">{code}</div>
                    {action?.reasons?.[code] && <div className="desc">{action.reasons[code]}</div>}
                  </div>
                  <div className="bar">
                    <span style={{ width: `${Math.max(p * 100, 1.5)}%` }} />
                  </div>
                  <div className="p">{p >= 0.995 ? "1.00" : p.toFixed(2)}</div>
                </div>
              ))}
              <p className="note" style={{ margin: "14px 0 0" }}>
                Each signal is judged on its own. The list says what is present; it is not a causal explanation of the
                risk score.
              </p>
            </Card>
          )}

          {typology && (
            <Card title="Most likely explanation" className="o-typology">
              <div className="typology-bar">
                {Object.entries(typology.probabilities).map(([code, p]) => (
                  <span
                    key={code}
                    className={code === typology.value ? "top" : ""}
                    style={{ flex: Math.max(p, 0.004) }}
                    title={`${code} ${p.toFixed(2)}`}
                  />
                ))}
              </div>
              <div className="legend">
                {Object.entries(typology.probabilities)
                  .sort((a, b) => b[1] - a[1])
                  .map(([code, p]) => (
                    <span key={code}>
                      <b>{p.toFixed(2)}</b> {action?.typologies?.[code]?.split(":")[0] ?? code}
                    </span>
                  ))}
              </div>
            </Card>
          )}

          {!traced && scores.length > 0 && (
            <Card title={scores.length === 1 ? "Model score" : `Model scores · ${scores.length}`} className="o-signals">
              <div className="stack">
                {scores.map((s) => (
                  <div key={s.step}>
                    <div className="row wrap" style={{ justifyContent: "space-between" }}>
                      <a className="mono" href={href("settings", "models", slugOfRef(s.model))}>
                        {s.model}
                      </a>
                      <span>
                        <b className="mono">{s.score.toFixed(4)}</b>{" "}
                        <span className="muted">risk score {s.risk_score}</span>
                      </span>
                    </div>
                    {s.missing.length > 0 && (
                      <div className="row wrap" style={{ margin: "8px 0" }}>
                        <span className="muted" style={{ fontSize: 12.5 }}>
                          Missing, so the model took its default branch
                        </span>
                        <Chips items={s.missing} tone="warn" />
                      </div>
                    )}
                    <KV data={s.features} />
                  </div>
                ))}
              </div>
              <p className="note" style={{ margin: "14px 0 0" }}>
                The values each score read, as the workflow gave them. A score is a probability from 0 to 1.
              </p>
            </Card>
          )}

          {traced ? null : asked ? (
            <Card title={`What happened · last ${d.context.recent_events.length} events`} className="o-timeline">
              <Timeline
                events={d.context.recent_events}
                pending={d.context.pending_action}
                outcome={outcome}
                entityTypes={entityTypes}
              />
            </Card>
          ) : (
            <Card title="Decided by a workflow" className="o-timeline">
              <p className="note" style={{ margin: 0 }}>
                The workflow <span className="mono">{workflow}</span> made this decision without asking a question
                model, so there is no history that a model read, and no answer.{" "}
                {workflowRun && <a href={href("workflow-runs", workflowRun)}>See the run</a>}
              </p>
            </Card>
          )}

          {baseline && (
            <Card
              title={`Usual behaviour · ${baseline.events.toLocaleString()} older events`}
              className="o-baseline flush-table"
            >
              <table>
                <thead>
                  <tr>
                    <th>Event type</th>
                    <th style={{ textAlign: "right" }}>Count</th>
                    <th>Profile</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(baseline.event_types).map(([type, profile]) => (
                    <tr key={type}>
                      <td>{type.replaceAll("_", " ")}</td>
                      <td className="mono" style={{ textAlign: "right" }}>
                        {profile.count}
                      </td>
                      <td className="profile">
                        <Chips
                          max={4}
                          items={Object.entries(profile.fields ?? {}).map(([field, f]: [string, any]) =>
                            "median" in f
                              ? `${field} median ${f.median.toLocaleString()} · max ${f.max.toLocaleString()}`
                              : "values" in f
                                ? `${field} ${Object.entries(f.values)
                                    .slice(0, 2)
                                    .map(([v, n]) => `${v}×${n}`)
                                    .join(" ")}`
                                : `${field} ${f.distinct} distinct`,
                          )}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note" style={{ margin: "14px 0 0" }}>
                {stamp(baseline.period[0])} to {stamp(baseline.period[1])}. Older events are summarised; rare events and
                free text are kept in full.
              </p>
            </Card>
          )}

          {asked && (
            <Card className="o-raw">
              <details>
                <summary>Model input and answer</summary>
                <pre>
                  {JSON.stringify(
                    { context: d.context, answers: d.raw.answers, input_tokens: d.raw.usage.input_tokens },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </Card>
          )}
        </div>

        <aside className="stack">
          <Card title={asked ? "Pending action" : "The request"} className="o-pending">
            <KV
              data={asked ? d.context.pending_action : { ...d.request?.entities, ...d.request?.properties }}
              entityTypes={entityTypes}
            />
          </Card>

          {asked && d.context.this_session && (
            <Card
              title={`This session · ${d.context.this_session.events} ${d.context.this_session.events === 1 ? "event" : "events"} before the request`}
              className="o-links"
            >
              <div className="code-list">
                {d.context.this_session.steps.map((step, i) => {
                  const [clock, ...what] = step.split(" ");
                  return (
                    <div key={i}>
                      <span className="mono">{clock}</span>
                      <span>{what.join(" ")}</span>
                    </div>
                  );
                })}
              </div>
              <p className="note" style={{ margin: "10px 0 0" }}>
                Started {d.context.this_session.started_before_this_action} before the request. Minutes and seconds are
                counted from the start of the session.
                {Object.entries(d.context.this_session)
                  .filter(([key]) => key.startsWith("other_"))
                  .map(([key, value]) => ` ${String(value)} ${key.replaceAll("_", " ")}.`)}
              </p>
            </Card>
          )}
          {asked && d.context.totals && (
            <Card title="Totals" className="o-links">
              <div className="code-list">
                {Object.entries(d.context.totals).map(([name, value]) => (
                  <div key={name}>
                    <span className="mono">{name.replaceAll("_", " ")}</span>
                    <span>{totalText(value)}</span>
                  </div>
                ))}
              </div>
              <p className="note" style={{ margin: "10px 0 0" }}>
                Calculated over the subject's events for this decision, as the action asks.
              </p>
            </Card>
          )}
          {links.length > 0 && (
            <Card title="Linked entities" className="o-links">
              {links.map(([key, block]) => {
                const [type, ...rest] = key.split(" ");
                const flat = (o: Record<string, any>) =>
                  Object.fromEntries(Object.entries(o).filter(([, v]) => v === null || typeof v !== "object"));
                const recentKey = Object.keys(block).find((k) => /^last_\d+_days$/.test(k));
                const recent = recentKey ? (block[recentKey] as Record<string, any>) : null;
                const allTime = Object.entries(block).find(([k]) => k.endsWith("_by_label"))?.[1] as
                  Record<string, any> | undefined;
                return (
                  <div key={key} className="link-card">
                    <div className="head">
                      <span>{entityName(type!)}</span>
                      <a className="mono linkish" href={href("entities", type, rest.join(" "))}>
                        {rest.join(" ")}
                      </a>
                    </div>
                    <KV data={{ ...block.about, ...flat(block) }} />
                    {block.labels && (
                      <div className="chips" style={{ marginTop: 10 }}>
                        {block.labels.map((l: string) => (
                          <span key={l} className="chip warn">
                            {l}
                          </span>
                        ))}
                      </div>
                    )}
                    <LabelShares labels={allTime} />
                    {recent && (
                      <div className="sub-block">
                        <div className="sub-title">{recentKey!.replaceAll("_", " ")}</div>
                        <KV
                          data={Object.fromEntries(
                            Object.entries(recent)
                              .filter(([k]) => k !== "by_label")
                              .map(([k, v]: [string, any]) => {
                                if (v === null || typeof v !== "object") return [k, v];
                                // { other_users: 5, of_them_new_accounts: 5 } → "5, of them 5 new"
                                const [count, fresh] = Object.values(v) as number[];
                                return [k, fresh ? `${count}, of them ${fresh} new` : String(count)];
                              }),
                          )}
                        />
                        <LabelShares labels={recent.by_label} />
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
          )}

          <DecisionDeliveries decisionId={d.id} />

          {asked && (
            <Card title={`About this ${entityName(d.subject.type)}`} className="o-about">
              <KV data={d.context.subject} skip={["type", "id"]} />
            </Card>
          )}

          <Card title="Was this right?" className="o-feedback">
            {feedback ? (
              <div className="banner ok" style={{ margin: 0 }}>
                Recorded <span className="mono">{feedback}</span> on this {entityName(d.subject.type)}.
              </div>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                <button className="btn danger block-w" onClick={() => label("fraud_confirmed")}>
                  Confirm fraud
                </button>
                <button className="btn good block-w" onClick={() => label("cleared")}>
                  Mark as legitimate
                </button>
                <p className="note" style={{ margin: "4px 0 0" }}>
                  Outcomes become labels. They make links meaningful and are what thresholds are tuned on.
                </p>
              </div>
            )}
          </Card>

          <ResolutionCard d={d} onResolved={reload} />
        </aside>
      </div>
    </div>
  );
}
