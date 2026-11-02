import { conditionSentence, type CaseCategory, type CaseView } from "@kairos/core";
import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../../api/client";
import { queues } from "../../api/index";
import { ActionRef } from "../../components/actions/ActionRef";
import { Pill, Score } from "../../components/decisions/Outcome";
import { TypeIcon } from "../../components/entities/EntityIcon";
import { FactsCard } from "../../components/entities/EntityFacts";
import { EntityLists } from "../../components/entities/EntityLists";
import { Card } from "../../components/ui/Card";
import { Chips } from "../../components/ui/Chips";
import { Loading } from "../../components/ui/states";
import { useApi } from "../../hooks/useApi";
import { cellText } from "../../lib/facts";
import { IMAGE_TYPES, openFile } from "../../lib/files";
import { dayOf, durationText, entityName, stamp, timeOf, valueText } from "../../lib/format";
import { CATEGORY_LABEL, PRIORITY_LABEL, PRIORITY_TONE, STATUS_LABEL, ageText, dueText } from "../../lib/queues";
import { go, href } from "../../lib/route";
import type {
  CaseActivity,
  CaseDetail,
  CaseEvidence,
  CaseStep,
  EntityDefinition,
  MediaItem,
  Outcome,
  ResolvedBlock,
  ViewValue,
} from "../../types/interfaces";

export interface CaseContext {
  c: CaseDetail;
  me: string;
  /** A person by user id or by email → their name. */
  members: Record<string, string>;
  actions: Record<string, string>;
  definitions: Record<string, EntityDefinition | undefined>;
  busy: boolean;
  act: (work: () => Promise<unknown>) => void;
  caseRows: Set<string>;
  /** In the layout editor: the layout being changed. Nothing private is read, and nothing is written. */
  draft?: CaseView;
}

export const TargetName = ({ c }: { c: Pick<CaseDetail, "target" | "target_name"> }) =>
  c.target_name ? <>{c.target_name}</> : <span className="mono">{c.target.id}</span>;

const statusTone = (status: CaseDetail["status"]) =>
  status === "resolved" ? "ok" : status === "in_review" ? "accent" : "";

export function ValueText({ v }: { v: ViewValue }) {
  if (v.value === null || v.value === undefined || v.value === "") return <span className="muted">—</span>;
  switch (v.field) {
    case "case.status":
      return (
        <span className={`chip ${statusTone(v.value as CaseDetail["status"])}`}>
          {STATUS_LABEL[v.value as CaseDetail["status"]]}
        </span>
      );
    case "case.priority":
      return (
        <span className={`chip ${PRIORITY_TONE[v.value as CaseDetail["priority"]]}`}>
          {PRIORITY_LABEL[v.value as CaseDetail["priority"]]}
        </span>
      );
    case "decision.outcome":
      return <Pill outcome={v.value as Outcome} />;
    case "case.age":
      return <>{durationText(Number(v.value))}</>;
    case "case.due": {
      const due = dueText(String(v.value));
      return due.late ? <span className="chip warn">{due.text}</span> : <>{due.text}</>;
    }
    case "case.opened":
      return <>{stamp(String(v.value))} UTC</>;
  }
  return (
    <>{cellText({ field: v.field, label: v.label, format: v.format, currency: v.currency }, { [v.field]: v.value })}</>
  );
}

function Evidence({ c, actions }: Pick<CaseContext, "c" | "actions">) {
  const groups = new Map<string, CaseEvidence[]>();
  for (const e of c.evidence) {
    const key = `${e.source.type}:${e.source.id}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  return (
    <div className="trigger-list">
      {[...groups.values()].map((group) => {
        const first = group[0]!;
        const s = first.snapshot;
        return (
          <div key={first.id} className="trigger">
            <div className="trigger-head">
              {s.decision ? (
                <>
                  <a href={href("decisions", s.decision.id)}>
                    <Pill outcome={s.decision.outcome} />
                  </a>
                  <span className="mono">risk {s.decision.risk_score}</span>
                  <span className="muted">·</span>
                  <ActionRef action={s.decision.action} names={actions} />
                </>
              ) : s.workflow ? (
                <>
                  <span className="chip accent">Workflow</span>
                  <a href={href("workflow-runs", s.workflow.run_id)}>{s.workflow.name}</a>
                </>
              ) : (
                <span className="chip">Event</span>
              )}
              <span className="grow" />
              <span className="mono muted">{stamp(first.ts)}</span>
            </div>
            {group.map((e) =>
              e.rule ? (
                <div key={e.id} className="trigger-rule">
                  <div>
                    <b>{e.rule.name}</b>
                    {e.snapshot.rule && <span className="muted"> · {e.snapshot.rule}</span>}
                  </div>
                  {e.snapshot.conditions && (
                    <div className="held-list">
                      {e.snapshot.conditions.map((cond, i) => (
                        <div key={i} className={cond.held ? "" : "no"}>
                          {cond.held ? "✓" : "✗"} {conditionSentence(cond)}: read{" "}
                          <span className="mono">{cond.read === undefined ? "nothing" : valueText(cond.read)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div key={e.id} className="trigger-rule">
                  <div>{e.snapshot.reason}</div>
                  {e.snapshot.workflow && (
                    <div className="held-list">
                      <div className="no">
                        Step <span className="mono">{e.snapshot.workflow.step}</span> of run{" "}
                        <span className="mono">{e.snapshot.workflow.run_id}</span>
                      </div>
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}

function Decisions({ c, actions, title }: Pick<CaseContext, "c" | "actions"> & { title?: string }) {
  return (
    <div className="card table-wrap">
      <div className="table-head">
        {title ?? `${c.decisions.length} ${c.decisions.length === 1 ? "decision" : "decisions"}`}
      </div>
      {c.decisions.length === 0 ? (
        <div className="empty muted">No decisions. A workflow made this case without one.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Outcome</th>
              <th>Risk</th>
              <th>Action</th>
              <th className="hide-md">Signals</th>
              <th>Resolution</th>
              <th style={{ textAlign: "right" }}>Decided</th>
            </tr>
          </thead>
          <tbody>
            {c.decisions.map((d) => (
              <tr key={d.id} className="link" onClick={() => go("decisions", d.id)}>
                <td>
                  <Pill outcome={d.decision.decision} />
                </td>
                <td style={{ width: 150 }}>
                  <Score value={d.decision.risk_score} outcome={d.decision.decision} />
                </td>
                <td>
                  <ActionRef action={d.action} names={actions} />
                </td>
                <td className="hide-md signals">
                  <Chips items={d.decision.reasons} max={2} />
                </td>
                <td>
                  {d.resolution ? (
                    <span>→ {d.resolution.outcome === "approve" ? "Approved" : "Blocked"}</span>
                  ) : (
                    <span className="muted">Not resolved</span>
                  )}
                </td>
                <td className="mono muted" style={{ textAlign: "right" }}>
                  {stamp(d.ts)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Steps({ steps, actions }: { steps: CaseStep[]; actions: Record<string, string> }) {
  let day = "";
  return (
    <div className="timeline">
      {steps.map((s, i) => {
        const d = dayOf(s.ts);
        const head = d !== day ? ((day = d), (<div className="day">{d}</div>)) : null;
        return (
          <div key={i} style={{ display: "contents" }}>
            {head}
            {s.kind === "event" ? (
              <div className={`tl ${s.item ? "" : "context"}`}>
                <span className="node" />
                <time>{timeOf(s.ts)}</time>
                <div className="body">
                  <span className="type">{s.event.type.replaceAll("_", " ")}</span>
                  {Object.entries(s.event.entities).map(([type, id]) => (
                    <a key={type} className="chip to" href={href("entities", type, id)}>
                      {type} {id}
                    </a>
                  ))}
                  {Object.entries(s.event.properties)
                    .slice(0, 4)
                    .map(([k, v]) => (
                      <span key={k} className="chip">
                        {k} {valueText(v)}
                      </span>
                    ))}
                  {s.event.status && <span className="chip">status {s.event.status}</span>}
                </div>
              </div>
            ) : (
              <div className={`tl pending t-${s.decision.decision.decision} ${s.item ? "" : "context"}`}>
                <span className="node" />
                <time>{timeOf(s.ts)}</time>
                <div className="body">
                  <a className="type" href={href("decisions", s.decision.id)}>
                    Decision · <ActionRef action={s.decision.action} names={actions} />
                  </a>
                  <Pill outcome={s.decision.decision.decision} />
                  <span className="chip">risk {s.decision.decision.risk_score}</span>
                  <a className="chip to" href={href("entities", s.decision.subject.type, s.decision.subject.id)}>
                    {s.decision.subject.type} {s.decision.subject.id}
                  </a>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Timeline({ c, actions, title }: Pick<CaseContext, "c" | "actions"> & { title?: string }) {
  const [itemsOnly, setItemsOnly] = useState(false);
  const timeline = useApi(["case-timeline", c.id, itemsOnly, c.last_activity], () => queues.timeline(c.id, itemsOnly));
  return (
    <section className="card pad">
      <div className="card-title-row">
        <h2>{title ?? "What happened"}</h2>
        <label className="check plain">
          <input type="checkbox" checked={itemsOnly} onChange={(e) => setItemsOnly(e.target.checked)} /> Only this case
        </label>
      </div>
      {!timeline.data ? (
        <Loading />
      ) : timeline.data.steps.length === 0 ? (
        <span className="muted">No events.</span>
      ) : (
        <Steps steps={timeline.data.steps} actions={actions} />
      )}
      {!itemsOnly && (
        <p className="note" style={{ margin: "12px 0 0" }}>
          Lighter: what else happened around {entityName(c.target.type)} <TargetName c={c} />, which is not part of this
          case.
        </p>
      )}
    </section>
  );
}

function Details({ c, me, title }: Pick<CaseContext, "c" | "me"> & { title?: string }) {
  const resolved = c.status === "resolved";
  const due = !resolved && c.due_at ? dueText(c.due_at) : null;
  return (
    <Card title={title ?? "Details"}>
      <dl className="kv">
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`chip ${statusTone(c.status)}`}>{STATUS_LABEL[c.status]}</span>
          </dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>
            <span className={`chip ${PRIORITY_TONE[c.priority]}`}>{PRIORITY_LABEL[c.priority]}</span>
          </dd>
        </div>
        <div>
          <dt>Assignee</dt>
          <dd>
            {c.assignee ? (
              <>
                {c.assignee.name}
                {c.assignee.id === me && <span className="muted"> (you)</span>}
              </>
            ) : (
              <span className="muted">Nobody</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Queue</dt>
          <dd>
            <a className="linkish" href={href("queues", c.queue.id)}>
              {c.queue.name}
            </a>
          </dd>
        </div>
        {c.outcome && (
          <div>
            <dt>Worst outcome</dt>
            <dd>
              <Pill outcome={c.outcome} /> <span className="mono muted">risk {c.risk}</span>
            </dd>
          </div>
        )}
        <div>
          <dt>Opened</dt>
          <dd className="mono">{stamp(c.created)} UTC</dd>
        </div>
        {!resolved && (
          <div>
            <dt>Waiting</dt>
            <dd>{ageText(c.created)}</dd>
          </div>
        )}
        {due && c.due_at && (
          <div>
            <dt>Due</dt>
            <dd title={`${stamp(c.due_at)} UTC`}>
              {due.late ? <span className="chip warn">{due.text}</span> : due.text}
            </dd>
          </div>
        )}
        {c.correlation_key && (
          <div className="long">
            <dt>Key</dt>
            <dd className="mono">{c.correlation_key}</dd>
          </div>
        )}
      </dl>
    </Card>
  );
}

function Objects({ c, definitions, title }: Pick<CaseContext, "c" | "definitions"> & { title?: string }) {
  const entities = c.items.filter((i) => i.kind === "entity");
  const sessions = c.items.filter((i) => i.kind === "session");
  const records = c.items.filter((i) => i.kind === "record");
  return (
    <Card title={title ?? `Objects · ${entities.length + sessions.length + records.length}`} className="o-links">
      <div className="linked-list">
        {entities.map((e) => (
          <a key={`${e.type} ${e.id}`} href={href("entities", e.type!, e.id)}>
            <TypeIcon type={e.type!} definition={definitions[e.type!]} size="sm" />
            <span className="chip">{entityName(e.type!)}</span>
            {c.names[`${e.type} ${e.id}`] ? (
              <span className="grow">
                {c.names[`${e.type} ${e.id}`]} <span className="mono muted">{e.id}</span>
              </span>
            ) : (
              <span className="mono grow">{e.id}</span>
            )}
            {e.type === c.target.type && e.id === c.target.id && <span className="chip accent">About</span>}
          </a>
        ))}
        {sessions.map((s) => (
          <a key={s.id} href={href("sessions", s.id)}>
            <span className="chip">Session</span>
            <span className="mono grow">{s.id}</span>
          </a>
        ))}
        {records.map((r) => (
          <div key={r.id} className="row">
            <span className="chip">Record</span>
            <span className="mono grow">{r.id}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function activityText(a: CaseActivity, members: Record<string, string>): string {
  const p = a.payload;
  switch (a.type) {
    case "created":
      return p.previous_case ? "Opened, after the case before it was closed to new triggers" : "Opened";
    case "evidence_added":
      return "Another trigger joined the case";
    case "assigned":
      return p.assignee ? `Assigned to ${members[String(p.assignee)] ?? String(p.assignee)}` : "Unassigned";
    case "status_changed":
      return p.next_case
        ? "Closed to new triggers: a later trigger opened a new case"
        : `${STATUS_LABEL[p.from as keyof typeof STATUS_LABEL] ?? String(p.from)} → ${STATUS_LABEL[p.to as keyof typeof STATUS_LABEL] ?? String(p.to)}`;
    case "note":
      return String(p.text ?? "");
    case "resolved":
      return `Resolved: ${CATEGORY_LABEL[p.category as CaseCategory] ?? String(p.category)}${p.note ? ` · ${String(p.note)}` : ""}`;
    case "reopened":
      return p.source ? "Reopened by a new trigger" : "Reopened";
    case "viewed":
      return `Opened ${String(p.title ?? "a sensitive block")}`;
    case "checked":
      return `${p.checked ? "Checked" : "Cleared"}: ${String(p.point)}`;
    case "command": {
      const subject = p.subject as { type?: string; id?: string } | undefined;
      const who = subject?.id ? `${subject.type ?? ""} ${subject.id}`.trim() : "";
      return `Issued ${String(p.label ?? p.command ?? "a command")}${who ? ` on ${who}` : ""}`;
    }
  }
}

function mediaProblem(item: MediaItem, error: unknown): string | null {
  if (item.state === "missing") return "None on this case.";
  if (item.state === "not_a_link") return "Its field does not hold an address.";
  if (item.state === "host_not_approved")
    return `Its host, ${item.host}, is not approved. An admin can approve it in Settings › Workspace.`;
  if (error instanceof ApiError && error.status === 410) return "The link has expired.";
  if (error) return (error as Error).message;
  return null;
}

/** Read only once a person chose to see it. */
function MediaImage({
  caseId,
  blockId,
  item,
  shown,
}: {
  caseId: string;
  blockId: string;
  item: MediaItem;
  shown: boolean;
}) {
  const { data: blob, error } = useApi(
    ["case-media", caseId, blockId, item.index],
    () => queues.media(caseId, blockId, item.index),
    {
      enabled: item.state === "ready" && shown,
    },
  );
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob || !IMAGE_TYPES.includes(blob.type)) return;
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  const problem = mediaProblem(item, error);
  return (
    <figure className="media">
      {problem ? (
        <div className="media-empty muted">{problem}</div>
      ) : !shown ? (
        <div className="media-empty hidden-media muted">Hidden</div>
      ) : url ? (
        <a href={url} target="_blank" rel="noreferrer" title="Open at full size">
          <img src={url} alt={item.label} />
        </a>
      ) : (
        <div className="media-empty muted">Loading…</div>
      )}
      <figcaption>{item.label}</figcaption>
    </figure>
  );
}

function Images({ c, block, preview }: { c: CaseDetail; block: ResolvedBlock; preview: boolean }) {
  const sensitive = block.sensitive !== false;
  const [shown, setShown] = useState(!sensitive && !preview);
  const show = () => (setShown(true), void queues.viewed(c.id, block.id).catch(() => undefined));
  return (
    <Card title={block.title ?? "Images"}>
      <div className="media-grid">
        {(block.media ?? []).map((m) => (
          <MediaImage key={m.index} caseId={c.id} blockId={block.id} item={m} shown={shown} />
        ))}
      </div>
      {!shown && !preview && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={show}>
            Show the images
          </button>
          <small className="muted">Showing them is recorded in the activity.</small>
        </div>
      )}
    </Card>
  );
}

function Documents({ c, block, preview }: { c: CaseDetail; block: ResolvedBlock; preview: boolean }) {
  const sensitive = block.sensitive !== false;
  const [problems, setProblems] = useState<Record<number, string>>({});
  const [recorded, setRecorded] = useState(false);
  const open = async (item: MediaItem) => {
    const tab = window.open("", "_blank");
    try {
      const blob = await queues.media(c.id, block.id, item.index);
      if (sensitive && !recorded) (setRecorded(true), void queues.viewed(c.id, block.id).catch(() => undefined));
      openFile(blob, item.label, tab);
    } catch (e) {
      tab?.close();
      setProblems({ ...problems, [item.index]: mediaProblem(item, e) ?? "It could not be read." });
    }
  };
  return (
    <Card title={block.title ?? "Documents"}>
      <div className="linked-list">
        {(block.media ?? []).map((m) => {
          const problem = problems[m.index] ?? mediaProblem(m, null);
          return (
            <div key={m.index} className="row">
              <span className="grow">
                {m.label}
                {problem && <small className="muted"> · {problem}</small>}
              </span>
              <button className="btn compact" disabled={preview || m.state !== "ready"} onClick={() => open(m)}>
                Open
              </button>
            </div>
          );
        })}
      </div>
      {sensitive && <small className="muted">Opening one is recorded in the activity.</small>}
    </Card>
  );
}

function Checklist({
  c,
  block,
  members,
  busy,
  act,
  draft,
}: Pick<CaseContext, "c" | "members" | "busy" | "act" | "draft"> & { block: ResolvedBlock }) {
  const resolved = c.status === "resolved" || !!draft;
  return (
    <Card title={block.title ?? "Checklist"}>
      <div className="checklist">
        {(block.checks ?? []).map((check, i) => (
          <label key={check.point} className={`check-point ${check.checked ? "on" : ""}`}>
            <input
              type="checkbox"
              checked={check.checked}
              disabled={busy || resolved}
              onChange={(e) => act(() => queues.check(c.id, block.id, i, e.target.checked))}
            />
            <span className="grow">{check.point}</span>
            {check.by && (
              <small className="muted">
                {members[check.by] ?? check.by} · {stamp(check.at!)}
              </small>
            )}
          </label>
        ))}
      </div>
    </Card>
  );
}

function Activity({
  c,
  members,
  busy,
  act,
  draft,
  title,
}: Pick<CaseContext, "c" | "members" | "busy" | "act" | "draft"> & { title?: string }) {
  const [note, setNote] = useState("");
  return (
    <Card title={title ?? "Activity"}>
      <ol className="activity">
        {c.activity.map((a) => (
          <li key={a.id} className={a.type === "note" ? "note-item" : ""}>
            <div>{activityText(a, members)}</div>
            <small>
              {members[a.actor] ?? a.actor} · {stamp(a.created)}
            </small>
          </li>
        ))}
      </ol>
      {c.status !== "resolved" && !draft && (
        <form
          className="row"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) act(() => queues.note(c.id, note.trim()).then(() => setNote("")));
          }}
        >
          <input
            className="input grow"
            placeholder="Add a note"
            value={note}
            maxLength={5000}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className="btn" disabled={busy || !note.trim()}>
            Add
          </button>
        </form>
      )}
    </Card>
  );
}

const aboutText = (e: { type: string; id: string; name: string | null }) =>
  `About ${entityName(e.type).toLowerCase()} ${e.name ?? e.id}`;

export function CaseBlock({ block, ctx }: { block: ResolvedBlock; ctx: CaseContext }): ReactNode {
  const { c } = ctx;
  switch (block.type) {
    case "evidence":
      return (
        <Card
          title={
            block.title ??
            `Why this case exists · ${c.evidence.length} ${c.evidence.length === 1 ? "trigger" : "triggers"}`
          }
        >
          <Evidence c={c} actions={ctx.actions} />
        </Card>
      );
    case "decisions":
      return <Decisions c={c} actions={ctx.actions} title={block.title} />;
    case "timeline":
      return <Timeline c={c} actions={ctx.actions} title={block.title} />;
    case "details":
      return <Details c={c} me={ctx.me} title={block.title} />;
    case "objects":
      return <Objects c={c} definitions={ctx.definitions} title={block.title} />;
    case "activity":
      return (
        <Activity c={c} members={ctx.members} busy={ctx.busy} act={ctx.act} draft={ctx.draft} title={block.title} />
      );
    case "text":
      return (
        <Card title={block.title} className="text-block">
          <p>{block.text}</p>
        </Card>
      );
    case "fields":
      return (
        <Card title={block.title ?? "Fields"}>
          <dl className="kv">
            {(block.values ?? []).map((v) => (
              <div key={v.field}>
                <dt>{v.label}</dt>
                <dd>
                  <ValueText v={v} />
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      );
    case "facts":
      return (
        <>
          {(block.entities ?? []).map((e) => (
            <FactsCard key={`${e.type} ${e.id}`} facts={e.facts ?? []} title={block.title ?? aboutText(e)} />
          ))}
        </>
      );
    case "images":
      return <Images c={c} block={block} preview={!!ctx.draft} />;
    case "documents":
      return <Documents c={c} block={block} preview={!!ctx.draft} />;
    case "checklist":
      return <Checklist c={c} block={block} members={ctx.members} busy={ctx.busy} act={ctx.act} draft={ctx.draft} />;
    case "list": {
      const many = (block.entities ?? []).length > 1 || block.of?.startsWith("item.");
      return (
        <>
          {(block.entities ?? [])
            .filter((e) => e.lists?.length)
            .map((e) => (
              <EntityLists
                key={`${e.type} ${e.id}`}
                entity={e}
                lists={e.lists!}
                rows={block.rows ?? 5}
                marked={ctx.caseRows}
                title={block.title ?? (many ? aboutText(e) : undefined)}
                cacheKey={
                  ctx.draft
                    ? `preview ${c.id} ${block.id} ${JSON.stringify(ctx.draft.lists ?? [])}`
                    : `case ${c.id} ${block.id}`
                }
                load={(name, page) =>
                  ctx.draft
                    ? queues.previewList(c.id, ctx.draft, block.id, e, name, page)
                    : queues.viewList(c.id, block.id, e, name, page)
                }
              />
            ))}
        </>
      );
    }
  }
}
