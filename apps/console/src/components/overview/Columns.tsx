import { useState } from "react";
import { Breakdown } from "./Breakdown";
import { useTip } from "../../hooks/useTip";
import { OUTCOMES } from "../../lib/outcomes";
import { sum, type OverviewData } from "../../lib/overview";

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 4, 5, 10].map((m) => m * magnitude).find((m) => m >= value)!;
}

export function Columns({ series }: { series: OverviewData["series"] }) {
  const tip = useTip();
  const [on, setOn] = useState<number | null>(null);
  const { points, bucket } = series;
  const max = niceMax(Math.max(...points.map(sum), 1));
  const date = (t: string) => new Date(t);
  const day = (t: string) => date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const label = (t: string) =>
    bucket === "hour" ? `${day(t)}, ${String(date(t).getUTCHours()).padStart(2, "0")}:00 UTC` : day(t);
  const step = Math.max(1, Math.ceil(points.length / 6));
  const ticks = points
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => (bucket === "hour" ? date(p.t).getUTCHours() === 0 || i === 0 : i % step === 0));

  return (
    <div className="columns">
      <div className="y-axis">
        {[0, 0.5, 1].map((f) => (
          <span key={f} style={{ bottom: `${f * 100}%` }}>
            {Math.round(max * f).toLocaleString()}
          </span>
        ))}
      </div>
      <div className={`plot ${on !== null ? "hovering" : ""}`} onMouseLeave={() => (setOn(null), tip.hide())}>
        <div className="grid" style={{ bottom: "50%" }} />
        <div className="grid" style={{ bottom: "100%" }} />
        {points.map((p, i) => (
          <div
            key={p.t}
            className={`col ${on === i ? "on" : ""}`}
            onMouseMove={(e) => {
              setOn(i);
              tip.show(
                e,
                <>
                  <b>{label(p.t)}</b>
                  {sum(p) === 0 ? "No decisions" : <Breakdown counts={p} />}
                </>,
              );
            }}
          >
            {OUTCOMES.filter((o) => p[o] > 0).map((o) => (
              <span key={o} className={`t-${o}`} style={{ height: `${(100 * p[o]) / max}%` }} />
            ))}
          </div>
        ))}
      </div>
      <div className="x-axis">
        {ticks.map(({ p, i }) => (
          <span key={p.t} style={{ left: `${(100 * i) / points.length}%` }}>
            {day(p.t)}
          </span>
        ))}
      </div>
      {tip.node}
    </div>
  );
}
