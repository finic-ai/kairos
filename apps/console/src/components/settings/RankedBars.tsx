import { useState } from "react";
import { SHORT } from "../../pages/settings/UsagePage";

export const share = (part: number, whole: number) =>
  !whole
    ? "—"
    : part > 0 && part / whole < 0.001
      ? "<0.1%"
      : `${((100 * part) / whole).toFixed(part / whole < 0.1 ? 1 : 0)}%`;

interface BarRow {
  key: string;
  name: string;
  link?: string;
  value: number;
  note: string;
}

/**
 * The largest five as bars, and the rest as one row, so that the list is the same height
 * with five types or with fifty. "Show all" opens the full list.
 */
export function RankedBars({
  rows,
  otherNote,
  mono,
  detail,
}: {
  rows: BarRow[];
  otherNote: (rest: BarRow[]) => string;
  mono?: boolean;
  detail?: boolean;
}) {
  const [all, setAll] = useState(false);
  const top = rows[0]?.value || 1;
  const shown = all || rows.length <= SHORT + 1 ? rows : rows.slice(0, SHORT);
  const rest = rows.slice(shown.length);
  const width = (value: number) => `${Math.max((value / top) * 100, 1)}%`;
  return (
    <div className="card pad">
      <div className={`usage-bars ${detail ? "with-detail" : ""}`}>
        {shown.map((row) => (
          <div key={row.key}>
            {row.link ? (
              <a className="name" href={row.link} title={row.key}>
                {row.name}
              </a>
            ) : (
              <span className={`name ${mono ? "mono" : ""}`} title={row.key}>
                {row.name}
              </span>
            )}
            <span className="track">
              <span style={{ width: width(row.value) }} />
            </span>
            <b>{row.value.toLocaleString()}</b>
            <small>{row.note}</small>
          </div>
        ))}
        {rest.length > 0 && (
          <div className="other">
            <span className="name">{rest.length} more</span>
            <span className="track">
              <span
                style={{
                  width: width(
                    Math.min(
                      rest.reduce((sum, r) => sum + r.value, 0),
                      top,
                    ),
                  ),
                }}
              />
            </span>
            <b>{rest.reduce((sum, r) => sum + r.value, 0).toLocaleString()}</b>
            <small>{otherNote(rest)}</small>
          </div>
        )}
      </div>
      {rows.length > SHORT + 1 && (
        <button type="button" className="btn ghost usage-more" onClick={() => setAll(!all)}>
          {all ? "Show the largest only" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}
