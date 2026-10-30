import { useState } from "react";
import { ActionRef } from "../../components/actions/ActionRef";
import { Pill } from "../../components/decisions/Outcome";
import { Breakdown } from "../../components/overview/Breakdown";
import { Columns } from "../../components/overview/Columns";
import { Panel } from "../../components/overview/Panel";
import { StackedBar } from "../../components/overview/StackedBar";
import { DashSkeleton } from "../../components/ui/Skeleton";
import { Empty, Failure } from "../../components/ui/states";
import { useActionNames } from "../../hooks/useActionNames";
import { useApi } from "../../hooks/useApi";
import { useTip } from "../../hooks/useTip";
import { stamp } from "../../lib/format";
import { OUTCOME_LABEL, OUTCOMES } from "../../lib/outcomes";
import { href } from "../../lib/route";
import { loadOverview } from "../../lib/overview";

const percent = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)}%` : "—");

export function OverviewPage() {
  const names = useActionNames();
  const { data, error } = useApi(["overview"], loadOverview, { refetchInterval: 8000 });
  const tip = useTip();
  const [bin, setBin] = useState<number | null>(null);
  const head = (
    <header className="page-head">
      <div>
        <h1>Overview</h1>
        <p className="lede">What Kairos decided, what it is holding, and what is driving it.</p>
      </div>
    </header>
  );
  if (error) return <Failure message={error.message} />;
  if (!data)
    return (
      <>
        {head}
        <DashSkeleton numbers={4} panels={[8, 4, 6, 6, 5, 7]} />
      </>
    );

  const total = data.decisions;
  const held = data.outcomes.review + data.outcomes.block;
  const topAction = Math.max(...data.by_action.map((a) => a.total), 1);
  const topReason = Math.max(...data.reasons.map((r) => r.count), 1);
  const tallest = Math.max(...data.histogram, 1);
  const span =
    data.series.points.length > 1
      ? `${stamp(data.series.points[0].t)} to ${stamp(data.series.points[data.series.points.length - 1].t)} UTC`
      : "";

  return (
    <>
      {head}

      {total === 0 ? (
        <div className="card">
          <Empty title="No decisions yet">
            Define an action and call decide() from the SDK. The numbers appear here.
          </Empty>
        </div>
      ) : (
        <div className="dash">
          <section className="card panel kpi span-3">
            <div className="label">Decisions</div>
            <div className="value">{total.toLocaleString()}</div>
            <div className="sub">across {data.actions} actions</div>
          </section>
          <section className="card panel kpi span-3">
            <div className="label">Held for review or blocked</div>
            <div className="value">
              {held.toLocaleString()}
              <small>{percent(held, total)}</small>
            </div>
            <div className="sub">
              {data.outcomes.block.toLocaleString()} blocked · {data.outcomes.review.toLocaleString()} in review
            </div>
          </section>
          <section className="card panel kpi span-3">
            <div className="label">Approved without intervention</div>
            <div className="value">
              {data.outcomes.approve.toLocaleString()}
              <small>{percent(data.outcomes.approve, total)}</small>
            </div>
            <div className="sub">{data.outcomes.step_up.toLocaleString()} more were stepped up</div>
          </section>
          <section className="card panel kpi span-3">
            <div className="label">Events tracked</div>
            <div className="value">{data.events.toLocaleString()}</div>
            <div className="sub">
              {data.entities.toLocaleString()} entities of {data.entity_types} kinds · {data.labelled.toLocaleString()}{" "}
              labelled
            </div>
          </section>

          <Panel title="Decisions over time" note={`per ${data.series.bucket} · ${span}`} span={8}>
            <div className="legend-row" style={{ marginBottom: 14 }}>
              {OUTCOMES.map((o) => (
                <span key={o} className={`t-${o}`}>
                  <i />
                  {OUTCOME_LABEL[o]}
                </span>
              ))}
            </div>
            <Columns series={data.series} />
          </Panel>

          <Panel title="Outcomes" note={`${total.toLocaleString()} decisions`} span={4}>
            <div className="bar" style={{ height: 12, marginBottom: 12 }}>
              {OUTCOMES.filter((o) => data.outcomes[o] > 0).map((o) => (
                <span key={o} className={`t-${o}`} style={{ flex: data.outcomes[o] }} />
              ))}
            </div>
            {OUTCOMES.map((o) => (
              <div key={o} className={`split-row t-${o}`}>
                <span>
                  <i />
                  {OUTCOME_LABEL[o]}
                </span>
                <b>{data.outcomes[o].toLocaleString()}</b>
                <em>{percent(data.outcomes[o], total)}</em>
              </div>
            ))}
          </Panel>

          <Panel title="By action" link={<a href={href("actions")}>All actions →</a>} span={6}>
            <div className="bar-rows">
              {data.by_action.map((a) => (
                <a
                  key={a.action}
                  className="bar-row"
                  href={href("actions", a.action)}
                  onMouseMove={(e) =>
                    tip.show(
                      e,
                      <>
                        <b>{a.action}</b>
                        <Breakdown counts={a} />
                      </>,
                    )
                  }
                  onMouseLeave={tip.hide}
                >
                  <span className="name mono">{a.action}</span>
                  <StackedBar counts={a} scale={topAction} />
                  <span className="value">{a.total.toLocaleString()}</span>
                </a>
              ))}
            </div>
          </Panel>

          <Panel title="Most frequent signals" note="decisions where the signal was present" span={6}>
            {data.reasons.length === 0 ? (
              <span className="muted">No action reports signals yet.</span>
            ) : (
              <div className="bar-rows">
                {data.reasons.map((r) => (
                  <div
                    key={r.code}
                    className="bar-row"
                    onMouseMove={(e) =>
                      tip.show(
                        e,
                        <>
                          <b>{r.code}</b>
                          Present in {r.count} decisions. {r.held} of them were not approved ({percent(r.held, r.count)}
                          ).
                        </>,
                      )
                    }
                    onMouseLeave={tip.hide}
                  >
                    <span className="name mono">{r.code}</span>
                    <div className="bar single" style={{ width: `${Math.max((100 * r.count) / topReason, 1)}%` }}>
                      <span style={{ flex: 1 }} />
                    </div>
                    <span className="value">{r.count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Risk score distribution" note="decisions per ten points of score" span={5}>
            <div
              className={`histogram ${bin !== null ? "hovering" : ""}`}
              onMouseLeave={() => (setBin(null), tip.hide())}
            >
              {data.histogram.map((n, i) => (
                <div
                  key={i}
                  className={bin === i ? "on" : ""}
                  style={{ height: `${(100 * n) / tallest}%` }}
                  onMouseMove={(e) => {
                    setBin(i);
                    tip.show(
                      e,
                      <>
                        <b>
                          Score {i * 10} to {i === 9 ? 100 : i * 10 + 9}
                        </b>
                        {n.toLocaleString()} decisions ({percent(n, data.sampled)})
                      </>,
                    );
                  }}
                />
              ))}
            </div>
            <div className="axis-ends">
              <span>0</span>
              <span>50</span>
              <span>100</span>
            </div>
            <p className="note" style={{ margin: "14px 0 0" }}>
              The score is the probability that the action should be held, × 100.
            </p>
          </Panel>

          <section className="card span-7 attention" style={{ display: "flex", flexDirection: "column" }}>
            <div className="panel-head" style={{ padding: "18px 20px 0" }}>
              <h3>Needs attention</h3>
              <a href={href("decisions")}>All decisions →</a>
            </div>
            {data.attention.length === 0 ? (
              <div className="empty">Nothing is held.</div>
            ) : (
              data.attention.map((d) => (
                <a key={d.id} href={href("decisions", d.id)}>
                  <Pill outcome={d.decision.decision} />
                  <span className="mono">{d.decision.risk_score}</span>
                  <span className="who mono">
                    {d.subject.id}
                    <small>
                      <ActionRef action={d.action} names={names} />
                    </small>
                  </span>
                  <time className="mono muted">{stamp(d.ts)}</time>
                </a>
              ))
            )}
          </section>
        </div>
      )}
      {tip.node}
    </>
  );
}
