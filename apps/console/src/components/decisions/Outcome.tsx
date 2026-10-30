import type { Outcome } from "../../types/interfaces";
import { OUTCOME_LABEL } from "../../lib/outcomes";

export function Pill({ outcome, large }: { outcome: Outcome; large?: boolean }) {
  return (
    <span className={`pill t-${outcome}${large ? " lg" : ""}`}>
      <i />
      {OUTCOME_LABEL[outcome]}
    </span>
  );
}

export function Score({ value, outcome }: { value: number; outcome: Outcome }) {
  return (
    <div className={`score t-${outcome}`}>
      <b>{value}</b>
      <div className="meter">
        <span style={{ width: `${Math.max(value, 2)}%` }} />
      </div>
    </div>
  );
}

export function Gauge({ value, outcome }: { value: number; outcome: Outcome }) {
  const r = 58;
  const c = 2 * Math.PI * r;
  return (
    <div className={`gauge t-${outcome}`}>
      <svg width="132" height="132" viewBox="0 0 132 132" aria-hidden>
        <circle className="track" cx="66" cy="66" r={r} fill="none" strokeWidth="7" />
        <circle
          className="arc"
          cx="66"
          cy="66"
          r={r}
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.max(value, 1) / 100)}
        />
      </svg>
      <div className="num">
        <b>{value}</b>
        <small>risk score</small>
      </div>
    </div>
  );
}
