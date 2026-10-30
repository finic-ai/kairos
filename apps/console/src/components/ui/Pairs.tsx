export type Pair = [code: string, description: string];

export function Pairs({
  items,
  onChange,
  codeHint,
  textHint,
}: {
  items: Pair[];
  onChange: (next: Pair[]) => void;
  codeHint: string;
  textHint: string;
}) {
  const set = (i: number, k: 0 | 1, value: string) =>
    onChange(items.map((p, j) => (j === i ? ((k === 0 ? [value, p[1]] : [p[0], value]) as Pair) : p)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {items.map(([code, text], i) => (
        <div className="pair" key={i}>
          <input
            className="input mono"
            placeholder={codeHint}
            value={code}
            onChange={(e) => set(i, 0, e.target.value)}
          />
          <input className="input" placeholder={textHint} value={text} onChange={(e) => set(i, 1, e.target.value)} />
          <button
            type="button"
            className="icon-btn"
            aria-label="Remove"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn ghost" onClick={() => onChange([...items, ["", ""]])}>
          + Add
        </button>
      </div>
    </div>
  );
}
