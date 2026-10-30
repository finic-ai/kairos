import { useState } from "react";
import { api } from "../../api/index";
import type { MetricResult } from "../../types/interfaces";
import { formatValue, TimeChart } from "../../components/charts/charts";
import { RankedBars, share } from "../../components/settings/RankedBars";
import { Group, Row } from "../../components/ui/Group";
import { Loading } from "../../components/ui/states";
import { useActionNames } from "../../hooks/useActionNames";
import { useApi } from "../../hooks/useApi";
import { href } from "../../lib/route";
import type { SettingsPageProps } from "./types";

const PERIODS = [7, 30, 90];

export const SHORT = 5;

export function UsagePage({ workspace }: SettingsPageProps) {
  const [days, setDays] = useState(30);
  const { data, error } = useApi(["usage", days], () => api.usage(days), { refetchInterval: 30_000 });
  const names = useActionNames();

  const start = data ? Date.parse(data.since) : 0;
  const buckets = data
    ? Array.from({ length: data.days_asked }, (_, i) => new Date(start + i * 86_400_000).toISOString())
    : [];
  const byDay = new Map((data?.days ?? []).map((d) => [d.day, d]));
  const series = (key: "events" | "decisions" | "input_tokens"): MetricResult => {
    const values = buckets.map((b) => byDay.get(b.slice(0, 10))?.[key] ?? 0);
    return {
      buckets,
      series: [{ key: "all", total: values.reduce((a, b) => a + b, 0), values }],
      total: values.reduce((a, b) => a + b, 0),
      unit: "count",
      truncated: false,
    };
  };
  const events = series("events");
  const decisions = series("decisions");
  const tokens = series("input_tokens");

  return (
    <>
      <h1>Usage</h1>
      {error && <div className="banner">{error.message}</div>}

      <Group
        title={`Last ${days} days`}
        note="Counted in whole UTC days. Today is the last day."
        action={
          <div className="seg">
            {PERIODS.map((n) => (
              <button key={n} className={days === n ? "on" : ""} onClick={() => setDays(n)}>
                {n} days
              </button>
            ))}
          </div>
        }
      >
        {!data ? (
          <div className="card">
            <Loading />
          </div>
        ) : (
          <>
            <div className="usage-totals">
              <div className="card">
                <span>Events received</span>
                <b>{events.total.toLocaleString()}</b>
                <small>{data.stored.events.toLocaleString()} stored in all</small>
              </div>
              <div className="card">
                <span>Decisions</span>
                <b>{decisions.total.toLocaleString()}</b>
                <small>{data.stored.decisions.toLocaleString()} stored in all</small>
              </div>
              <div className="card">
                <span>Model input tokens</span>
                <b>{formatValue(tokens.total, "count")}</b>
                <small>
                  {decisions.total
                    ? `${Math.round(tokens.total / decisions.total).toLocaleString()} for a decision, on average`
                    : "No decisions in this period"}
                </small>
              </div>
            </div>
            <div className="card pad usage-chart">
              <h3>Events received each day</h3>
              {events.total > 0 ? (
                <TimeChart data={events} kind="bar" interval="day" height={170} />
              ) : (
                <p className="note">No events were received in this period.</p>
              )}
            </div>
            <div className="card pad usage-chart">
              <h3>Decisions each day</h3>
              {decisions.total > 0 ? (
                <TimeChart data={decisions} kind="bar" interval="day" height={170} />
              ) : (
                <p className="note">No decisions were made in this period.</p>
              )}
            </div>
          </>
        )}
      </Group>

      {data && data.by_action.length > 0 && (
        <Group
          title="Decisions by action"
          note="Each decision is one call to the model. The tokens are what the model read: the history, the question and the signals."
        >
          <RankedBars
            detail
            rows={data.by_action.map((a) => ({
              key: a.action,
              name: names[a.action] ?? a.action,
              link: href("actions", a.action),
              value: a.decisions,
              note: `${formatValue(a.input_tokens, "count")} tokens · ${Math.round(a.input_tokens / a.decisions).toLocaleString()} each`,
            }))}
            otherNote={(rest) =>
              `${formatValue(
                rest.reduce((sum, r) => sum + (data.by_action.find((a) => a.action === r.key)?.input_tokens ?? 0), 0),
                "count",
              )} tokens`
            }
          />
        </Group>
      )}

      {data && data.by_event_type.length > 0 && (
        <Group title="Events by type">
          <RankedBars
            mono
            rows={data.by_event_type.map((e) => ({
              key: e.type,
              name: e.type,
              value: e.events,
              note: share(e.events, events.total),
            }))}
            otherNote={(rest) =>
              share(
                rest.reduce((sum, r) => sum + r.value, 0),
                events.total,
              )
            }
          />
        </Group>
      )}

      {data && (
        <Group title="Stored in this environment">
          <div className="card rows">
            <Row title="Events">
              <span className="mono">{data.stored.events.toLocaleString()}</span>
            </Row>
            <Row title="Entities">
              <span className="mono">{data.stored.entities.toLocaleString()}</span>
            </Row>
            <Row title="Decisions">
              <span className="mono">{data.stored.decisions.toLocaleString()}</span>
            </Row>
          </div>
        </Group>
      )}
    </>
  );
}
