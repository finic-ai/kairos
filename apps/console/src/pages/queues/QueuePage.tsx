import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { queues } from "../../api/index";
import type { ResolveBody } from "../../api/queues";
import { Pill, Score } from "../../components/decisions/Outcome";
import { EntityIcon } from "../../components/entities/EntityIcon";
import { InTopbar } from "../../components/shell/InTopbar";
import { FilterSelect } from "../../components/ui/FilterSelect";
import { Switch } from "../../components/ui/Switch";
import { PAGE_SIZES, Pager } from "../../components/ui/Pager";
import { Empty, Failure, Loading } from "../../components/ui/states";
import { useActionNames } from "../../hooks/useActionNames";
import { useApi, useMembers } from "../../hooks/useApi";
import { useWorkspace } from "../../hooks/useWorkspace";
import { entityName, stamp, valueText } from "../../lib/format";
import {
  PRIORITY_LABEL,
  PRIORITY_TONE,
  QUEUE_DISPLAY,
  STATUS_LABEL,
  ageText,
  columnLabel,
  dueText,
  correlationSentence,
  definitionOf,
} from "../../lib/queues";
import { go, hashQuery, href } from "../../lib/route";
import type { CaseSummary, Queue } from "../../types/interfaces";
import { AssignMenu } from "./AssignMenu";
import { ResolveModal } from "./ResolveModal";

const ORDER_NOTE: Record<string, string> = {
  newest: "newest first",
  risk: "highest risk first",
  priority: "highest priority first",
  oldest: "oldest first",
  due: "soonest due first",
};

function Cell({ column, c }: { column: string; c: CaseSummary }) {
  switch (column) {
    case "target":
      return (
        <td>
          <span className="chip">{entityName(c.target.type)}</span>{" "}
          {c.target_name ? (
            <>
              {c.target_name} <span className="mono muted">{c.target.id}</span>
            </>
          ) : (
            <span className="mono">{c.target.id}</span>
          )}
        </td>
      );
    case "priority":
      return (
        <td>
          <span className={`chip ${PRIORITY_TONE[c.priority]}`}>{PRIORITY_LABEL[c.priority]}</span>
        </td>
      );
    case "status":
      return (
        <td>
          <span className={`chip ${c.status === "resolved" ? "ok" : c.status === "in_review" ? "accent" : ""}`}>
            {STATUS_LABEL[c.status]}
          </span>
        </td>
      );
    case "assignee":
      return <td>{c.assignee ? c.assignee.name : <span className="muted">—</span>}</td>;
    case "age":
      return <td className="mono muted">{c.status === "resolved" ? "—" : ageText(c.created)}</td>;
    case "due": {
      if (!c.due_at || c.status === "resolved") return <td className="muted">—</td>;
      const due = dueText(c.due_at);
      return (
        <td className="mono" title={`${stamp(c.due_at)} UTC`}>
          {due.late ? <span className="chip warn">{due.text}</span> : <span className="muted">{due.text}</span>}
        </td>
      );
    }
    case "last_activity":
      return <td className="mono muted">{stamp(c.last_activity)}</td>;
    case "outcome":
      return <td>{c.outcome ? <Pill outcome={c.outcome} /> : <span className="muted">—</span>}</td>;
    case "risk":
      return (
        <td style={{ width: 150 }}>
          {c.risk !== null && c.outcome ? (
            <Score value={c.risk} outcome={c.outcome} />
          ) : (
            <span className="muted">—</span>
          )}
        </td>
      );
    case "evidence":
      return (
        <td className="mono" style={{ textAlign: "right" }}>
          {c.evidence_count}
        </td>
      );
    case "reason":
      return <td>{c.reason}</td>;
    default: {
      const value = c.values?.[column];
      return <td className="mono muted">{value === null || value === undefined ? "—" : valueText(value)}</td>;
    }
  }
}

function Cases({ queue, onChanged }: { queue: Queue; onChanged: () => void }) {
  const { workspace, session } = useWorkspace();
  const { data: memberList } = useMembers(workspace.id);
  const [, setSearchParams] = useSearchParams();
  const query = hashQuery();
  const [status, setStatus] = useState(() => query.get("status") ?? "unresolved");
  const [priority, setPriority] = useState(() => query.get("priority") ?? "");
  const [assignee, setAssignee] = useState(() => query.get("assignee") ?? "");
  const [due, setDue] = useState(() => query.get("due") ?? "");
  const [search, setSearch] = useState(() => query.get("q") ?? "");
  const [q, setQ] = useState(search);
  const [size, setSize] = useState(() =>
    PAGE_SIZES.includes(Number(query.get("size"))) ? Number(query.get("size")) : 50,
  );
  const [page, setPage] = useState(() => Math.max(1, Math.floor(Number(query.get("page"))) || 1));
  const filter = (change: () => void) => (change(), setPage(1));
  useEffect(() => {
    const timer = setTimeout(() => search.trim() !== q && filter(() => setQ(search.trim())), 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const next = new URLSearchParams();
    if (status !== "unresolved") next.set("status", status);
    if (priority) next.set("priority", priority);
    if (assignee) next.set("assignee", assignee);
    if (due) next.set("due", due);
    if (q) next.set("q", q);
    if (page > 1) next.set("page", String(page));
    if (size !== 50) next.set("size", String(size));
    setSearchParams(next, { replace: true });
  }, [status, priority, assignee, due, q, page, size]);

  const [picked, setPicked] = useState<string[]>([]);
  const [resolving, setResolving] = useState(false);
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => (setPicked([]), setResult(null)), [status, priority, assignee, due, q, page, size]);

  const list = useApi(
    ["queue-cases", queue.id, { status, priority, assignee, due, q, size, page }],
    () =>
      queues.cases(queue.id, {
        status: status === "all" ? "" : status,
        priority,
        assignee,
        due,
        q,
        limit: size,
        offset: (page - 1) * size,
      }),
    { refetchInterval: 8000 },
  );
  const columns = queue.columns?.length ? queue.columns : ["target", "priority", "status", "assignee", "age"];
  const total = list.data?.total ?? 0;
  const counts = queue.counts ?? { open: 0, in_review: 0, unassigned: 0, overdue: 0, open_decisions: 0, mine: 0 };
  const tabs: [string, string, number | null][] = [
    ["unresolved", "To do", counts.open + counts.in_review],
    ["open", "Open", counts.open],
    ["in_review", "In review", counts.in_review],
    ["resolved", "Resolved", null],
    ["open_decisions", "Resolved, decisions open", counts.open_decisions],
    ["all", "All", null],
  ];
  const narrowed = [priority, assignee, due, q].filter(Boolean).length;
  const clear = () => filter(() => (setPriority(""), setAssignee(""), setDue(""), setSearch(""), setQ("")));

  const shown = list.data?.cases ?? [];
  const allPicked = shown.length > 0 && shown.every((c) => picked.includes(c.id));
  const pick = (id: string) => setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : [...picked, id]);
  /** The cases it could not change stay selected. */
  const bulk = async (action: { assign: string | null } | { resolve: ResolveBody }, verb: string) => {
    const done = await queues.bulk(queue.id, { ids: picked, ...action });
    const failed = done.results.filter((r) => !r.ok);
    const changed = done.results.length - failed.length;
    setResult({
      ok: failed.length === 0,
      text:
        `${verb} ${changed} ${changed === 1 ? "case" : "cases"}.` +
        (failed.length ? ` ${failed.length} could not change: ${failed[0]!.error ?? "unknown error"}` : ""),
    });
    setPicked(failed.map((f) => f.id));
    list.refetch();
    onChanged();
  };
  const assign = async (userId: string | null) => {
    setWorking(true);
    try {
      await bulk({ assign: userId }, userId ? "Assigned" : "Unassigned");
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="card table-wrap">
      {result && (
        <div className={`banner ${result.ok ? "ok" : ""}`} style={{ margin: 12 }}>
          {result.text}
        </div>
      )}
      {resolving && (
        <ResolveModal
          title={`Resolve ${picked.length} ${picked.length === 1 ? "case" : "cases"}`}
          decisions={(target) => (
            <>the open decisions of these cases as {target === "approve" ? "approved" : "blocked"}</>
          )}
          label={(tag) => (
            <>
              the entity of each case <span className="mono">{tag}</span>
            </>
          )}
          onResolve={async (body) => {
            await bulk({ resolve: body }, "Resolved");
            setResolving(false);
          }}
          onClose={() => setResolving(false)}
        />
      )}
      {picked.length > 0 ? (
        <div className="case-toolbar picking">
          <span className="picked">{picked.length} selected</span>
          <div className="tools">
            <AssignMenu
              many
              me={session.user.id}
              assignee={null}
              members={memberList?.members ?? []}
              disabled={working}
              onAssign={assign}
            />
            <button className="btn primary" disabled={working} onClick={() => setResolving(true)}>
              Resolve
            </button>
            <button
              className="icon-btn"
              aria-label="Clear the selection"
              title="Clear the selection"
              onClick={() => setPicked([])}
            >
              ×
            </button>
          </div>
        </div>
      ) : (
        <div className="case-toolbar">
          <div className="seg tight scroll">
            {tabs.map(([value, label, count]) => (
              <button
                key={value}
                className={status === value ? "on" : ""}
                onClick={() => filter(() => setStatus(value))}
              >
                {label}
                {count !== null && <span className="count">{count.toLocaleString()}</span>}
              </button>
            ))}
          </div>
          <div className="tools">
            <input
              className="input search"
              placeholder="Search by id"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <FilterSelect
              label="Any priority"
              value={priority}
              onChange={(v) => filter(() => setPriority(v))}
              options={Object.entries(PRIORITY_LABEL) as [string, string][]}
            />
            <FilterSelect
              label="Anyone"
              value={assignee}
              onChange={(v) => filter(() => setAssignee(v))}
              options={[
                ["me", "Assigned to me"],
                ["none", "Not assigned"],
              ]}
            />
            <FilterSelect
              label="Any due time"
              value={due}
              onChange={(v) => filter(() => setDue(v))}
              options={[["overdue", counts.overdue ? `Overdue · ${counts.overdue.toLocaleString()}` : "Overdue"]]}
            />
            {narrowed > 0 && (
              <button className="icon-btn" aria-label="Clear the filters" title="Clear the filters" onClick={clear}>
                ×
              </button>
            )}
          </div>
        </div>
      )}
      {list.error && <Failure message={list.error.message} />}
      {!list.data ? (
        <Loading />
      ) : list.data.cases.length === 0 ? (
        <Empty title={narrowed || status !== "unresolved" ? "No cases match" : "Nothing to do"}>
          {narrowed || status !== "unresolved"
            ? "Change or clear the filters."
            : "A case opens here when a decision matches a rule of this queue."}
        </Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th className="pick">
                <input
                  type="checkbox"
                  aria-label="Select every case on this page"
                  checked={allPicked}
                  onChange={() => setPicked(allPicked ? [] : shown.map((c) => c.id))}
                />
              </th>
              {columns.map((c) => (
                <th key={c} style={c === "evidence" ? { textAlign: "right" } : undefined}>
                  {columnLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.data.cases.map((c) => (
              <tr key={c.id} className="link" onClick={() => go("cases", c.id)}>
                <td className="pick" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${c.target_name ?? c.target.id}`}
                    checked={picked.includes(c.id)}
                    onChange={() => pick(c.id)}
                  />
                </td>
                {columns.map((column) => (
                  <Cell key={column} column={column} c={c} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {total > 0 && (
        <Pager
          page={page}
          size={size}
          total={total}
          shown={list.data?.cases.length ?? 0}
          note={ORDER_NOTE[queue.sort ?? "oldest"]}
          onPage={setPage}
          onSize={(n) => (setSize(n), setPage(1))}
        />
      )}
    </div>
  );
}

export function QueuePage({ id }: { id: string }) {
  const { data: queue, error, refetch } = useApi(["queue", id], () => queues.get(id), { refetchInterval: 15_000 });
  const names = useActionNames();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (error) return <Failure message={error.message} />;
  if (!queue) return <Loading />;
  const display = QUEUE_DISPLAY(queue);
  const on = queue.enabled !== false;

  const toggle = async () => {
    if (
      on &&
      !confirm("A disabled queue takes no new cases, from rules or workflows. Its open cases stay. Disable it?")
    )
      return;
    setBusy(true);
    setProblem(null);
    try {
      await queues.save(queue.id, { ...definitionOf(queue), enabled: !on });
      refetch();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sources = (queue.sources.actions ?? []).map((a) => names[a] ?? a);
  return (
    <>
      <InTopbar slot="trail-slot">
        <span className="here">{queue.name}</span>
      </InTopbar>
      <header className="page-head with-actions">
        <div className="profile-head">
          <EntityIcon icon={display.icon} color={display.color} size="lg" />
          <div>
            <h1>{queue.name}</h1>
            {queue.description && <p className="queue-description">{queue.description}</p>}
            <div className="queue-facts">
              {!on && <span className="chip">Disabled</span>}
              {(queue.counts?.overdue ?? 0) > 0 && (
                <span className="chip warn">{queue.counts!.overdue.toLocaleString()} overdue</span>
              )}
              <span>
                {queue.intake.length} {queue.intake.length === 1 ? "rule" : "rules"}
                {sources.length > 0 && ` on ${sources.join(", ")}`}
              </span>
              <span>{correlationSentence(queue.correlation).split(".")[0]}</span>
            </div>
          </div>
        </div>
        <div className="row">
          <span className="switch-box" title={on ? "Rules and workflows add cases" : "This queue takes no new cases"}>
            <Switch checked={on} disabled={busy} onChange={toggle} label={on ? "Enabled" : "Disabled"} />
          </span>
          <a className="btn primary" href={href("queues", queue.id, "edit")}>
            Edit queue
          </a>
        </div>
      </header>
      {problem && <div className="banner">{problem}</div>}
      <Cases queue={queue} onChanged={refetch} />
    </>
  );
}
