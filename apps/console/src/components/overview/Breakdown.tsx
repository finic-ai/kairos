import { OUTCOME_LABEL, OUTCOMES } from "../../lib/outcomes";
import type { Counts } from "../../lib/overview";

export function Breakdown({ counts }: { counts: Counts }) {
  return (
    <>
      {OUTCOMES.filter((o) => counts[o] > 0).map((o) => (
        <div key={o} className={`t-${o}`}>
          <i />
          {OUTCOME_LABEL[o]} {counts[o].toLocaleString()}
        </div>
      ))}
    </>
  );
}
