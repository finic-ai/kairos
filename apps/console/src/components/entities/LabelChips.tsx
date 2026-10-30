const RISKY = /fraud|scam|report|takeover|sanction|mule/;

export function LabelChips({ labels }: { labels: string[] }) {
  return (
    <div className="chips">
      {labels.map((l) => (
        <span key={l} className={`chip ${RISKY.test(l) ? "warn" : "accent"}`}>
          {l}
        </span>
      ))}
    </div>
  );
}
