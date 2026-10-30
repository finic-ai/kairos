import { useState, CSSProperties } from "react";
import type { Interval } from "../../types/interfaces";
import type { MetricResult } from "../../types/interfaces";
import { useWidth } from "../../hooks/useWidth";

const OUTCOMES = new Set(["approve", "step_up", "review", "block"]);

export function colorOf(key: string, index: number): string {
  if (OUTCOMES.has(key)) return `var(--${key})`;
  if (key.startsWith("Other (") || key === "(none)") return "var(--ink-3)";
  return `var(--series-${(index % 8) + 1})`;
}

export const labelOf = (key: string) => (key === "all" ? "Total" : key.replaceAll("_", " "));

export function formatValue(value: number, unit: MetricResult["unit"]): string {
  if (unit === "percent") return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  if (Math.abs(value) >= 10_000)
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function formatBucket(ts: string, interval: Interval | undefined): string {
  const date = new Date(ts);
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  if (interval === "hour")
    return `${day}, ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })}`;
  return interval === "week" ? `Week of ${day}` : day;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const lead = value / power;
  return (lead <= 1 ? 1 : lead <= 2 ? 2 : lead <= 2.5 ? 2.5 : lead <= 5 ? 5 : 10) * power;
}

export function Legend({ data }: { data: MetricResult }) {
  if (data.series.length < 2) return null;
  return (
    <div className="legend-row">
      {data.series.map((s, i) => (
        <span key={s.key}>
          <i style={{ "--tone": colorOf(s.key, i) } as CSSProperties} />
          {labelOf(s.key)}
        </span>
      ))}
    </div>
  );
}

type TimeKind = "line" | "area" | "bar" | "stacked";

export function TimeChart({
  data,
  kind,
  interval,
  height = 210,
}: {
  data: MetricResult;
  kind: TimeKind;
  interval: Interval;
  height?: number;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const n = data.buckets.length;
  const stack = kind === "stacked" || kind === "area";
  // A share or an average of groups cannot be added up, so those are never stacked.
  const stacked = stack && data.unit === "count";
  const sums = data.buckets.map((_, i) => data.series.reduce((sum, s) => sum + s.values[i]!, 0));
  const top = niceMax(Math.max(...(stacked ? sums : data.series.flatMap((s) => s.values)), 0));

  const m = { left: 44, right: 10, top: 10, bottom: 24 };
  const w = Math.max(width - m.left - m.right, 10);
  const h = height - m.top - m.bottom;
  const bars = kind === "bar" || kind === "stacked";
  const step = bars ? w / Math.max(n, 1) : w / Math.max(n - 1, 1);
  const x = (i: number) => m.left + (bars ? step * (i + 0.5) : n === 1 ? w / 2 : step * i);
  const y = (v: number) => m.top + h - (v / top) * h;
  const ticks = [0, top / 2, top];
  const labels = n <= 1 ? [0] : n === 2 ? [0, 1] : [0, Math.floor((n - 1) / 2), n - 1];

  const onMove = (event: React.MouseEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = (event.clientX - box.left) / box.width;
    const i = Math.min(n - 1, Math.max(0, bars ? Math.floor(at * n) : Math.round(at * (n - 1))));
    setHover({ i, x: event.clientX, y: event.clientY });
  };

  const base = data.buckets.map(() => 0);
  const layers = data.series.map((s) =>
    s.values.map((v, i) => (stacked ? [base[i]!, (base[i] = base[i]! + v)] : [0, v]) as [number, number]),
  );
  const barWidth = Math.max(1, Math.min(step - 2, 46));
  const groupWidth = barWidth / Math.max(data.series.length, 1);

  return (
    <div className="chart" ref={ref}>
      {width > 0 && n > 0 && (
        <svg width={width} height={height} role="img" aria-label="Chart">
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} />
              <text className="axis" x={m.left - 8} y={y(t) + 4} textAnchor="end">
                {formatValue(t, data.unit)}
              </text>
            </g>
          ))}
          {labels.map((i) => (
            <text
              key={i}
              className="axis"
              x={x(i)}
              y={height - 6}
              textAnchor={i === 0 && !bars ? "start" : i === n - 1 && !bars ? "end" : "middle"}
            >
              {formatBucket(data.buckets[i]!, interval)}
            </text>
          ))}
          {hover && !bars && <line className="crosshair" x1={x(hover.i)} x2={x(hover.i)} y1={m.top} y2={m.top + h} />}
          {data.series.map((s, si) => {
            const color = colorOf(s.key, si);
            const layer = layers[si]!;
            if (bars) {
              return layer.map(([from, to], i) => {
                const left = x(i) - barWidth / 2 + (stacked ? 0 : groupWidth * si);
                const tall = Math.max(y(from) - y(to) - (stacked && to > from ? 1.5 : 0), 0);
                return (
                  <rect
                    key={`${s.key}${i}`}
                    x={left}
                    y={y(to)}
                    width={Math.max((stacked ? barWidth : groupWidth) - (stacked ? 0 : 1.5), 1)}
                    height={tall}
                    rx={Math.min(3, tall / 2)}
                    fill={color}
                    opacity={hover && hover.i !== i ? 0.45 : 1}
                  />
                );
              });
            }
            const line = layer.map(([, to], i) => `${i ? "L" : "M"}${x(i)},${y(to)}`).join("");
            const area = `${line}${[...layer]
              .reverse()
              .map(([from], r) => `L${x(n - 1 - r)},${y(from)}`)
              .join("")}Z`;
            return (
              <g key={s.key}>
                {kind === "area" && <path d={area} fill={color} opacity={stacked ? 0.28 : 0.12} />}
                <path
                  d={line}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {(n === 1 || hover) && (
                  <circle
                    cx={x(hover?.i ?? 0)}
                    cy={y(layer[hover?.i ?? 0]![1])}
                    r={4}
                    fill={color}
                    stroke="var(--surface)"
                    strokeWidth={2}
                  />
                )}
              </g>
            );
          })}
          <rect
            x={m.left}
            y={m.top}
            width={w}
            height={h}
            fill="transparent"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          />
        </svg>
      )}
      <Legend data={data} />
      {hover && (
        <div className="tip" style={{ left: Math.min(hover.x + 14, window.innerWidth - 220), top: hover.y + 14 }}>
          <b>{formatBucket(data.buckets[hover.i]!, interval)}</b>
          {data.series.map((s, i) => (
            <div key={s.key} className="tip-row">
              <i style={{ background: colorOf(s.key, i) }} />
              <span>{labelOf(s.key)}</span>
              <span>{formatValue(s.values[hover.i]!, data.unit)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function HBars({ data }: { data: MetricResult }) {
  const top = Math.max(...data.series.map((s) => s.total), 0) || 1;
  return (
    <div className="hbars">
      {data.series.map((s) => (
        <div key={s.key} title={`${labelOf(s.key)}: ${formatValue(s.total, data.unit)}`}>
          <span className="name">{labelOf(s.key)}</span>
          <span className="track">
            <span style={{ width: `${Math.max((s.total / top) * 100, 0.5)}%`, background: colorOf(s.key, 0) }} />
          </span>
          <span className="value">{formatValue(s.total, data.unit)}</span>
        </div>
      ))}
    </div>
  );
}

export function DataTable({ data, interval }: { data: MetricResult; interval?: Interval }) {
  const overTime = data.buckets.length > 0;
  const whole = data.series.reduce((sum, s) => sum + s.total, 0);
  return (
    <div className="data-table">
      <table>
        <thead>
          <tr>
            <th>{overTime ? "Period" : "Group"}</th>
            {overTime ? (
              data.series.map((s) => (
                <th key={s.key} style={{ textAlign: "right" }}>
                  {labelOf(s.key)}
                </th>
              ))
            ) : (
              <th style={{ textAlign: "right" }}>Value</th>
            )}
            {!overTime && data.unit === "count" && <th style={{ textAlign: "right" }}>Share</th>}
          </tr>
        </thead>
        <tbody>
          {overTime
            ? [...data.buckets.keys()].reverse().map((i) => (
                <tr key={i}>
                  <td>{formatBucket(data.buckets[i]!, interval)}</td>
                  {data.series.map((s) => (
                    <td key={s.key} className="num">
                      {formatValue(s.values[i]!, data.unit)}
                    </td>
                  ))}
                </tr>
              ))
            : data.series.map((s, i) => (
                <tr key={s.key}>
                  <td>
                    <i className="swatch" style={{ background: colorOf(s.key, i) }} />
                    {labelOf(s.key)}
                  </td>
                  <td className="num">{formatValue(s.total, data.unit)}</td>
                  {data.unit === "count" && (
                    <td className="num muted">{whole ? `${Math.round((s.total / whole) * 100)}%` : "—"}</td>
                  )}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}

export function BigNumber({ data, period }: { data: MetricResult; period: string }) {
  const before = data.previous_total;
  const change =
    before === undefined
      ? null
      : data.unit === "percent"
        ? data.total - before
        : before === 0
          ? null
          : ((data.total - before) / before) * 100;
  const sign = change === null ? "" : change > 0 ? "+" : "";
  return (
    <div className="big-number">
      <b>{formatValue(data.total, data.unit)}</b>
      <small>
        {change === null
          ? before === 0 && data.total > 0
            ? `None in the previous ${period}`
            : `No change data for the previous ${period}`
          : `${sign}${change.toLocaleString(undefined, { maximumFractionDigits: 1 })}${data.unit === "percent" ? " points" : "%"} vs the previous ${period}`}
      </small>
    </div>
  );
}
