const percent = (v: number) => `${v > 0 && v < 0.01 ? "<1" : Math.round(v * 100)}%`;

export function LabelShares({ labels }: { labels?: Record<string, any> }) {
  const entries = Object.entries(labels ?? {});
  if (entries.length === 0) return null;
  return (
    <div className="shares">
      {entries.map(([label, v]) => {
        // Older decisions stored a plain count.
        if (typeof v === "number")
          return (
            <span key={label} className="chip warn">
              {v} × {label}
            </span>
          );
        const count = Object.entries(v).find(([k]) => k !== "share" && k !== "normal_share")?.[1] as number;
        const high = v.share >= Math.max(3 * v.normal_share, 0.1);
        return (
          <div key={label} className={`share ${high ? "high" : ""}`}>
            <span className="chip warn">
              {count} × {label}
            </span>
            <span className="note">
              <b>{percent(v.share)}</b> against {percent(v.normal_share)} normally
            </span>
          </div>
        );
      })}
    </div>
  );
}
