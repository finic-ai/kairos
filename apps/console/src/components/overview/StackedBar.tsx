import { OUTCOMES } from "../../lib/outcomes";
import { sum, type Counts } from "../../lib/overview";

export function StackedBar({ counts, scale }: { counts: Counts; scale: number }) {
  return (
    <div className="bar" style={{ width: `${Math.max((100 * sum(counts)) / scale, 1)}%` }}>
      {OUTCOMES.filter((o) => counts[o] > 0).map((o) => (
        <span key={o} className={`t-${o}`} style={{ flex: counts[o] }} />
      ))}
    </div>
  );
}
