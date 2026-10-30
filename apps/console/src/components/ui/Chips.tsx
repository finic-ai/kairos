export function Chips({ items, max = 3, tone }: { items: string[]; max?: number; tone?: "warn" | "accent" }) {
  if (items.length === 0) return <span className="muted">—</span>;
  return (
    <div className="chips">
      {items.slice(0, max).map((item) => (
        <span key={item} className={`chip ${tone ?? ""}`}>
          {item}
        </span>
      ))}
      {items.length > max && <span className="chip">+{items.length - max}</span>}
    </div>
  );
}
