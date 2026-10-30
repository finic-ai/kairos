import type { ReactNode } from "react";
import { valueText } from "../../lib/format";
import { href } from "../../lib/route";

export function KV({
  data,
  skip = [],
  entityTypes,
  render,
}: {
  data: Record<string, unknown>;
  skip?: string[];
  entityTypes?: Set<string>;
  /** Shows a value its own way; undefined leaves it to the list. */
  render?: (key: string, value: unknown) => ReactNode | undefined;
}) {
  const entries = Object.entries(data).filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined);
  if (entries.length === 0) return <span className="muted">Nothing recorded</span>;
  return (
    <dl className="kv">
      {entries.map(([k, v]) => {
        const own = render?.(k, v);
        const nested = own === undefined && typeof v === "object" && !Array.isArray(v);
        const text = nested || own !== undefined ? "" : valueText(v);
        const long = nested || text.length > 34;
        return (
          <div key={k} className={long ? "long" : ""}>
            <dt>{k.replaceAll("_", " ")}</dt>
            <dd>
              {own !== undefined ? (
                own
              ) : entityTypes?.has(k) && typeof v === "string" ? (
                <a className="linkish" href={href("entities", k, v)}>
                  {v}
                </a>
              ) : nested ? (
                <span className="parts">
                  {Object.entries(v as Record<string, unknown>).map(([part, value]) => {
                    const shown = valueText(value);
                    return (
                      <span key={part} className={shown.length > 28 ? "long" : ""}>
                        <i>{part.replaceAll("_", " ")}</i>
                        <b>{shown}</b>
                      </span>
                    );
                  })}
                </span>
              ) : (
                text
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
