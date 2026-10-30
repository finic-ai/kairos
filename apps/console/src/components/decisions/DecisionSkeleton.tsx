import { RowsSkeleton, Skeleton } from "../ui/Skeleton";
import { href } from "../../lib/route";

export function DecisionSkeleton() {
  const card = (rows: number) => (
    <section className="card pad">
      <Skeleton width="30%" height={11} />
      <RowsSkeleton rows={rows} />
    </section>
  );
  return (
    <div aria-busy="true" aria-label="Loading">
      <a className="crumb" href={href("decisions")}>
        ← Decisions
      </a>
      <div className="split detail">
        <div className="stack">
          <section className="card hero">
            <Skeleton width={132} height={132} radius="50%" />
            <div className="skeleton-stack" style={{ flex: 1 }}>
              <Skeleton width={96} height={26} radius={999} />
              <Skeleton width="55%" height={28} />
              <Skeleton width="80%" height={12} />
            </div>
          </section>
          {card(4)}
          {card(7)}
        </div>
        <aside className="stack">
          {card(3)}
          {card(4)}
          {card(3)}
        </aside>
      </div>
    </div>
  );
}
