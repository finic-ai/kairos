import type { CSSProperties } from "react";

export function Skeleton({
  width = "100%",
  height = 12,
  radius,
}: {
  width?: CSSProperties["width"];
  height?: number;
  radius?: CSSProperties["borderRadius"];
}) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius }} aria-hidden="true" />;
}

const BARS = [42, 64, 50, 78, 58, 88, 70, 54, 74, 46, 82, 62];

export function ChartSkeleton({ height = 150 }: { height?: number }) {
  return (
    <div className="skeleton-chart" style={{ height }} aria-hidden="true">
      {BARS.map((h, i) => (
        <span key={i} className="skeleton" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

export function NumberSkeleton() {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      <Skeleton width="45%" height={30} />
      <Skeleton width="65%" height={11} />
    </div>
  );
}

export function RowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width={`${90 - ((i * 17) % 40)}%`} height={12} />
      ))}
    </div>
  );
}

export interface SkeletonColumn {
  width: CSSProperties["width"];
  height?: number;
  radius?: CSSProperties["borderRadius"];
  /** The class of the real cells, such as hide-md, so that the column hides where they do. */
  className?: string;
  align?: "right";
}

export function TableRowsSkeleton({ columns, rows = 8 }: { columns: SkeletonColumn[]; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} className="skeleton-row" aria-hidden="true">
          {columns.map((c, i) => (
            <td key={i} className={c.className} style={c.align ? { textAlign: c.align } : undefined}>
              <Skeleton width={c.width} height={c.height} radius={c.radius} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function DashSkeleton({ numbers = 0, panels }: { numbers?: number; panels: number[] }) {
  return (
    <div className="dash" aria-busy="true" aria-label="Loading">
      {Array.from({ length: numbers }, (_, i) => (
        <section key={`n${i}`} className="card panel kpi span-3">
          <Skeleton width="55%" height={11} />
          <NumberSkeleton />
        </section>
      ))}
      {panels.map((span, i) => (
        <section key={i} className={`card panel span-${span}`}>
          <div className="panel-head">
            <Skeleton width="35%" height={13} />
          </div>
          {i % 2 ? <RowsSkeleton /> : <ChartSkeleton />}
        </section>
      ))}
    </div>
  );
}
