import type { KairosEvent, Outcome } from "../../types/interfaces";
import { dayOf, timeOf, valueText } from "../../lib/format";
import { href } from "../../lib/route";
import { Pill } from "../decisions/Outcome";

export function Timeline({
  events,
  pending,
  outcome,
  rare = [],
  entityTypes,
}: {
  events: KairosEvent[];
  pending?: Record<string, unknown>;
  outcome?: Outcome;
  rare?: string[];
  /** Properties that name an entity; shown as links. */ entityTypes?: Set<string>;
}) {
  let day = "";
  return (
    <div className="timeline">
      {events.map((e, i) => {
        const { ts, type, text, ...rest } = e as KairosEvent & { text?: string };
        const d = dayOf(ts);
        const head = d !== day ? ((day = d), (<div className="day">{d}</div>)) : null;
        return (
          <div key={i} style={{ display: "contents" }}>
            {head}
            <div className={`tl ${rare.includes(type) || text ? "rare" : ""}`}>
              <span className="node" />
              <time>{timeOf(ts)}</time>
              <div className="body">
                <span className="type">{type.replaceAll("_", " ")}</span>
                {Object.entries(rest).map(([k, v]) =>
                  entityTypes?.has(k) && (typeof v === "string" || typeof v === "number") ? (
                    <a key={k} className="chip to" href={href("entities", k, String(v))}>
                      {k} {String(v)}
                    </a>
                  ) : (
                    <span key={k} className="chip">
                      {k} {valueText(v)}
                    </span>
                  ),
                )}
                {text && <div className="text">“{text}”</div>}
              </div>
            </div>
          </div>
        );
      })}
      {pending && outcome && (
        <div className={`tl pending t-${outcome}`}>
          <span className="node" />
          <time>{pending.requested_at ? timeOf(String(pending.requested_at)) : "now"}</time>
          <div className="body">
            <span className="type">Pending {String(pending.type).replaceAll("_", " ")}</span>
            {Object.entries(pending)
              .filter(([k, v]) => entityTypes?.has(k) && typeof v === "string")
              .map(([k, v]) => (
                <a key={k} className="chip to" href={href("entities", k, String(v))}>
                  {k} {String(v)}
                </a>
              ))}
            <Pill outcome={outcome} />
          </div>
        </div>
      )}
    </div>
  );
}
