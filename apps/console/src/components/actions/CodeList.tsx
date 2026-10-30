export function CodeList({ items, empty }: { items: Record<string, string> | undefined; empty: string }) {
  const entries = Object.entries(items ?? {});
  if (entries.length === 0)
    return (
      <p className="note" style={{ margin: 0 }}>
        {empty}
      </p>
    );
  return (
    <div className="code-list">
      {entries.map(([code, text]) => (
        <div key={code}>
          <span className="mono">{code}</span>
          <span>{text}</span>
        </div>
      ))}
    </div>
  );
}
