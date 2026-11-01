import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../api/index";
import type { Outcome } from "../../types/interfaces";
import { ActionRef } from "../../components/actions/ActionRef";
import { Pill, Score } from "../../components/decisions/Outcome";
import { DecidedByFilter, type DecidedBy } from "../../components/decisions/DecidedByFilter";
import { Chips } from "../../components/ui/Chips";
import { PAGE_SIZES, Pager } from "../../components/ui/Pager";
import { Skeleton, type SkeletonColumn, TableRowsSkeleton } from "../../components/ui/Skeleton";
import { Empty, Failure } from "../../components/ui/states";
import { useActions, useApi, useStats, useWorkflows } from "../../hooks/useApi";
import { actionName, stamp } from "../../lib/format";
import { OUTCOME_LABEL, OUTCOMES } from "../../lib/outcomes";
import { go, hashQuery, href } from "../../lib/route";

const QUERY_KEY: Record<DecidedBy, string> = { action: "action", workflow: "workflow", policy: "rule" };
// A rule id is unique only within its action, so a chosen rule is "action/rule".
const ruleFilter = (chosen: string) => {
  const at = chosen.indexOf("/");
  return at < 0 ? { rule: chosen } : { action: chosen.slice(0, at), rule: chosen.slice(at + 1) };
};

const head = (
  <thead>
    <tr>
      <th>Outcome</th>
      <th>Risk</th>
      <th>Subject</th>
      <th className="hide-md">Action</th>
      <th className="hide-md">Typology</th>
      <th className="hide-md">Signals</th>
      <th style={{ textAlign: "right" }}>Date</th>
    </tr>
  </thead>
);

const COLUMNS: SkeletonColumn[] = [
  { width: 78, height: 22, radius: 999 },
  { width: 120 },
  { width: 140 },
  { width: 110, className: "hide-md" },
  { width: 80, className: "hide-md" },
  { width: 130, className: "hide-md" },
  { width: 90, align: "right" },
];

export function DecisionsPage() {
  const [, setSearchParams] = useSearchParams();
  const [outcome, setOutcome] = useState<Outcome | "">(() => {
    const asked = hashQuery().get("outcome") as Outcome | null;
    return asked && OUTCOMES.includes(asked) ? asked : "";
  });
  const [by, setBy] = useState<DecidedBy>(() => {
    const asked = hashQuery().get("by") as DecidedBy | null;
    return asked && asked in QUERY_KEY ? asked : "action";
  });
  const [chosen, setChosen] = useState(() => hashQuery().get(QUERY_KEY[by]) ?? "");
  const stats = useStats(8000);
  const actions = useActions();
  const workflowList = useWorkflows();
  const deciders = (workflowList.data?.workflows ?? []).filter((w) => w.trigger.type === "decision");
  const names = Object.fromEntries((actions.data?.actions ?? []).map((a) => [a.name, actionName(a)]));
  const [size, setSize] = useState(() =>
    PAGE_SIZES.includes(Number(hashQuery().get("size"))) ? Number(hashQuery().get("size")) : 50,
  );
  const [page, setPage] = useState(() => Math.max(1, Math.floor(Number(hashQuery().get("page"))) || 1));
  const filter = (change: () => void) => (change(), setPage(1));
  const query = {
    outcome,
    ...(by === "action" ? { action: chosen } : by === "workflow" ? { workflow: chosen } : ruleFilter(chosen)),
    ...(by !== "action" && !chosen ? { decided_by: by } : {}),
  };
  const filtered = !!(outcome || chosen || by !== "action");
  const list = useApi(
    ["decisions", { ...query, size, page }],
    () => api.decisions({ ...query, limit: size, offset: (page - 1) * size }),
    { refetchInterval: 8000 },
  );
  const total = stats.data?.decisions ?? 0;
  const count = (o: Outcome) => stats.data?.outcomes[o] ?? 0;
  const shown = list.data?.decisions.length ?? 0;
  const matching = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(matching / size));

  useEffect(() => {
    const query = new URLSearchParams();
    if (outcome) query.set("outcome", outcome);
    if (by !== "action") query.set("by", by);
    if (chosen) query.set(QUERY_KEY[by], chosen);
    if (page > 1) query.set("page", String(page));
    if (size !== 50) query.set("size", String(size));
    setSearchParams(query, { replace: true });
  }, [outcome, by, chosen, page, size]);
  // The last page can go away while you are on it, when a filter result shrinks.
  useEffect(() => {
    if (list.data && page > pages) setPage(pages);
  }, [list.data, page, pages]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Decisions</h1>
          <p className="lede">
            Select a row for details. Every action Kairos was asked about, with its outcome, its score and the signals
            behind it.
          </p>
        </div>
        <button className="btn" onClick={() => (stats.refetch(), list.refetch())}>
          Refresh
        </button>
      </header>

      {(stats.error || list.error) && <Failure message={(stats.error ?? list.error)!.message} />}

      <div className="card tiles" style={{ marginBottom: 16 }}>
        <div className="tile">
          <div className="label">All decisions</div>
          <div className="value">{stats.data ? total.toLocaleString() : <Skeleton width={80} height={26} />}</div>
          <div className="distribution" aria-hidden>
            {total > 0 &&
              OUTCOMES.filter(count).map((o) => <span key={o} className={`t-${o}`} style={{ flex: count(o) }} />)}
          </div>
        </div>
        {OUTCOMES.map((o) => (
          <div key={o} className={`tile t-${o}`}>
            <div className="label">
              <i />
              {OUTCOME_LABEL[o]}
            </div>
            <div className="value">{stats.data ? count(o).toLocaleString() : <Skeleton width={60} height={26} />}</div>
            <div className="sub">
              {!stats.data ? (
                <Skeleton width={32} height={11} />
              ) : total ? (
                `${Math.round((100 * count(o)) / total)}%`
              ) : (
                "—"
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="filters">
        <div className="seg scroll">
          <button className={outcome === "" ? "on" : ""} onClick={() => filter(() => setOutcome(""))}>
            All outcomes
          </button>
          {OUTCOMES.map((o) => (
            <button
              key={o}
              className={`t-${o} ${outcome === o ? "on" : ""}`}
              onClick={() => filter(() => setOutcome(outcome === o ? "" : o))}
            >
              <i />
              {OUTCOME_LABEL[o]}
            </button>
          ))}
        </div>
        <DecidedByFilter
          by={by}
          chosen={chosen}
          options={{
            action: (actions.data?.actions ?? []).map((a) => ({ value: a.name, label: actionName(a) })),
            workflow: deciders.map((w) => ({
              value: w.name,
              label: `${actionName(w)} · ${names[String(w.trigger.action)] ?? String(w.trigger.action)}`,
            })),
            policy: (actions.data?.actions ?? []).flatMap((a) =>
              (a.policy?.rules ?? []).map((r) => ({ value: `${a.name}/${r.id}`, label: r.id, group: actionName(a) })),
            ),
          }}
          onChange={(nextBy, next) => filter(() => (setBy(nextBy), setChosen(next)))}
        />
      </div>

      <div className="card table-wrap">
        <div className="table-head">
          {!list.data ? (
            <Skeleton width={110} height={12} />
          ) : (
            `${matching.toLocaleString()} ${matching === 1 ? "decision" : "decisions"}${filtered ? " matching" : ""}`
          )}
        </div>
        {!list.data ? (
          <table>
            {head}
            <tbody>
              <TableRowsSkeleton columns={COLUMNS} />
            </tbody>
          </table>
        ) : shown === 0 ? (
          <Empty title="No decisions match">
            {filtered ? "Change the filters." : "Call decide() from the SDK and the result appears here."}
          </Empty>
        ) : (
          <table>
            {head}
            <tbody>
              {list.data.decisions.map((d) => (
                <tr key={d.id} className="link" onClick={() => go("decisions", d.id)}>
                  <td>
                    <Pill outcome={d.decision.decision} />
                    {d.resolution && <div className="resolved-cell">→ {OUTCOME_LABEL[d.resolution.outcome]}</div>}
                    {d.automatic && <div className="resolved-cell">automatic</div>}
                  </td>
                  <td style={{ width: 150 }}>
                    <Score value={d.decision.risk_score} outcome={d.decision.decision} />
                  </td>
                  <td className="mono">{d.subject.id}</td>
                  <td className="hide-md">
                    <ActionRef action={d.action} names={names} />
                    {typeof d.metadata?.decision_workflow === "string" && (
                      <div className="resolved-cell">
                        by workflow{" "}
                        <a
                          className="mono"
                          href={href("workflows", d.metadata.decision_workflow.split("@")[0]!)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {d.metadata.decision_workflow}
                        </a>
                      </div>
                    )}
                  </td>
                  <td className="hide-md">{d.decision.typology ?? <span className="muted">—</span>}</td>
                  <td className="hide-md signals">
                    <Chips items={d.decision.reasons} max={2} />
                  </td>
                  <td className="mono muted" style={{ textAlign: "right" }}>
                    {stamp(d.ts)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {matching > 0 && (
          <Pager
            page={page}
            size={size}
            total={matching}
            shown={shown}
            note="newest first"
            onPage={setPage}
            onSize={(n) => (setSize(n), setPage(1))}
          />
        )}
      </div>
    </>
  );
}
