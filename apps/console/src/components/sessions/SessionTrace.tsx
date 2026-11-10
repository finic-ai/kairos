import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { DecisionSummary, StoredEvent } from "../../types/interfaces";
import { ActionRef } from "../actions/ActionRef";
import { Pill } from "../decisions/Outcome";
import { Chips } from "../ui/Chips";
import { entityName } from "../../lib/format";
import { href } from "../../lib/route";

interface Span {
  event: StoredEvent;
  id: string;
  parent?: string;
  name: string;
  start: number;
  /** Equal to `start` for a span that sent no end. */
  end: number;
  error: boolean;
  decision?: DecisionSummary;
  children: Span[];
  depth: number;
}

const words = (text: string) => text.replaceAll("_", " ");

export function spanLength(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** The spans of one trace as a tree, in the order they started. A span whose parent was not sent is a root. */
function tree(events: StoredEvent[], decisions: Map<string, DecisionSummary>): Span[] {
  const spans = new Map<string, Span>();
  for (const event of events) {
    const t = event.trace!;
    // A span is one event. Another event that names the same span is a mistake of the sender: keep the first.
    if (spans.has(t.span_id)) continue;
    const start = Date.parse(event.ts);
    const end = t.end ? Math.max(start, Date.parse(t.end)) : start;
    spans.set(t.span_id, {
      event,
      id: t.span_id,
      parent: t.parent_span_id,
      name: t.name ?? words(event.type),
      start,
      end,
      error: t.status === "error",
      decision: decisions.get(event.id),
      children: [],
      depth: 0,
    });
  }
  const roots: Span[] = [];
  for (const span of spans.values()) {
    const parent = span.parent ? spans.get(span.parent) : undefined;
    (parent && parent !== span ? parent.children : roots).push(span);
  }
  const order = (list: Span[], depth: number, seen: Set<string>) => {
    list.sort((a, b) => a.start - b.start);
    for (const s of list) {
      s.depth = depth;
      seen.add(s.id);
      // A cycle in the parent ids would loop forever: cut it.
      s.children = s.children.filter((c) => !seen.has(c.id));
      order(s.children, depth + 1, seen);
    }
  };
  const seen = new Set<string>();
  order(roots, 0, seen);
  // Spans whose parents name each other reach no root: show each from where the cycle is cut.
  for (const s of spans.values())
    if (!seen.has(s.id)) {
      roots.push(s);
      order([s], 0, seen);
    }
  return roots.sort((a, b) => a.start - b.start);
}

/**
 * The session as traces: each span a bar on one time axis, under the span that started it,
 * with the decision on the span whose event asked for it. Spans come from events sent with `$trace`.
 */
export function SessionTrace({
  events,
  decisions,
  names,
}: {
  events: StoredEvent[];
  decisions: DecisionSummary[];
  names: Record<string, string>;
}) {
  const { traces, untraced } = useMemo(() => {
    const byEvent = new Map(decisions.filter((d) => d.event_id).map((d) => [d.event_id!, d]));
    const groups = new Map<string, StoredEvent[]>();
    for (const e of events)
      if (e.trace) (groups.get(e.trace.trace_id) ?? groups.set(e.trace.trace_id, []).get(e.trace.trace_id)!).push(e);
    const traces = [...groups.entries()]
      .map(([id, list]) => {
        const roots = tree(list, byEvent);
        const flat: Span[] = [];
        const walk = (l: Span[]) => l.forEach((s) => (flat.push(s), walk(s.children)));
        walk(roots);
        const start = Math.min(...flat.map((s) => s.start));
        const end = Math.max(...flat.map((s) => s.end));
        return { id, flat, start, end };
      })
      .sort((a, b) => a.start - b.start);
    return { traces, untraced: events.filter((e) => !e.trace).length };
  }, [events, decisions]);

  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<string | null>(null);

  if (traces.length === 0) return null;
  const toggle = (id: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section className="card spans" aria-label="Session trace">
      {traces.map((t) => {
        const length = Math.max(1, t.end - t.start);
        const hidden = new Set<string>();
        for (const s of t.flat)
          if (closed.has(s.id) || (s.parent && hidden.has(s.parent))) s.children.forEach((c) => hidden.add(c.id));
        const errors = t.flat.filter((s) => s.error).length;
        const held = t.flat.filter((s) => s.decision && s.decision.decision.decision !== "approve").length;
        return (
          <div key={t.id} className="spans-one">
            <div className="spans-head">
              <span className="mono spans-id" title="Trace id">
                {t.id}
              </span>
              <span className="muted">
                {t.flat.length} {t.flat.length === 1 ? "span" : "spans"} · {spanLength(t.end - t.start)}
              </span>
              {errors > 0 && <span className="chip warn">{errors} with an error</span>}
              {held > 0 && <span className="chip warn">{held} not approved</span>}
            </div>
            <div className="spans-axis" aria-hidden>
              <span />
              <div className="spans-ticks">
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                  <i key={f} style={{ left: `${f * 100}%` }}>
                    {spanLength(f * length)}
                  </i>
                ))}
              </div>
              <span />
            </div>
            <ol className="spans-rows">
              {t.flat
                .filter((s) => !hidden.has(s.id))
                .map((s) => {
                  const left = ((s.start - t.start) / length) * 100;
                  const width = ((s.end - s.start) / length) * 100;
                  const outcome = s.decision?.decision.decision;
                  const open = chosen === s.event.id;
                  return (
                    <Fragment key={s.id}>
                      <li className={`spans-row ${open ? "on" : ""} ${s.error ? "error" : ""}`}>
                        <div className="spans-name" style={{ paddingLeft: s.depth * 14 }}>
                          {s.children.length > 0 ? (
                            <button
                              className="spans-fold"
                              onClick={() => toggle(s.id)}
                              aria-expanded={!closed.has(s.id)}
                              aria-label={`${closed.has(s.id) ? "Show" : "Hide"} the spans under ${s.name}`}
                            >
                              {closed.has(s.id) ? "▸" : "▾"}
                            </button>
                          ) : (
                            <span className="spans-fold" />
                          )}
                          <button
                            className="spans-pick"
                            onClick={() => setChosen(open ? null : s.event.id)}
                            aria-expanded={open}
                          >
                            <span className="spans-label">{s.name}</span>
                          </button>
                        </div>
                        <div className="spans-lane" onClick={() => setChosen(open ? null : s.event.id)}>
                          <span
                            className={`spans-bar ${s.end === s.start ? "point" : ""} ${outcome ? `t-${outcome} decided` : ""}`}
                            style={{ left: `${left}%`, width: s.end === s.start ? undefined : `max(2px, ${width}%)` }}
                            title={`${s.name}: ${spanLength(s.end - s.start)}`}
                          />
                          {s.decision && (
                            <span
                              // Near the right edge there is no room after the bar: the badge goes before it.
                              className={`spans-mark t-${outcome} ${left + width > 85 ? "before" : ""}`}
                              style={{ left: `${left + width > 85 ? left : left + width}%` }}
                              title={`${outcome}, risk ${s.decision.decision.risk_score}`}
                            >
                              {s.decision.decision.risk_score}
                            </span>
                          )}
                        </div>
                        <span
                          className="spans-length mono muted"
                          title={s.end === s.start ? "No end was sent" : undefined}
                        >
                          {s.end === s.start ? "·" : spanLength(s.end - s.start)}
                        </span>
                      </li>
                      {open && (
                        <li className="spans-detail">
                          <SpanDetail span={s} offset={s.start - t.start} names={names} />
                        </li>
                      )}
                    </Fragment>
                  );
                })}
            </ol>
          </div>
        );
      })}
      {untraced > 0 && (
        <p className="note" style={{ margin: 0 }}>
          {untraced} {untraced === 1 ? "event" : "events"} of this session came with no span. The timeline shows them.
        </p>
      )}
    </section>
  );
}

function SpanDetail({ span, offset, names }: { span: Span; offset: number; names: Record<string, string> }) {
  const { event, decision } = span;
  const entities = Object.entries(event.entities);
  const properties = Object.entries(event.properties);
  return (
    <div className="spans-facts">
      {decision && (
        <a className={`spans-decision t-${decision.decision.decision}`} href={href("decisions", decision.id)}>
          <Pill outcome={decision.decision.decision} />
          <span className="mono">risk {decision.decision.risk_score}</span>
          <ActionRef action={decision.action} names={names} />
          {decision.decision.typology && <span className="chip">{words(decision.decision.typology)}</span>}
          {decision.decision.reasons.length > 0 && <Chips items={decision.decision.reasons} max={4} />}
        </a>
      )}
      <div className="spans-groups">
        <Facts title="Span">
          <Fact name="Event">{event.type}</Fact>
          <Fact name="Started">+{spanLength(offset)}</Fact>
          <Fact name="Length">{span.end === span.start ? "No end sent" : spanLength(span.end - span.start)}</Fact>
          {event.trace?.status && <Fact name="Status">{event.trace.status}</Fact>}
          <Fact name="Span id">{span.id}</Fact>
          {span.parent && <Fact name="Parent id">{span.parent}</Fact>}
        </Facts>
        {entities.length > 0 && (
          <Facts title="Entities">
            {entities.map(([type, id]) => (
              <Fact key={type} name={entityName(type)}>
                <a href={href("entities", type, id)}>{id}</a>
              </Fact>
            ))}
          </Facts>
        )}
        {properties.length > 0 && (
          <Facts title="Properties">
            {properties.map(([name, value]) => (
              <Fact key={name} name={name}>
                {value !== null && typeof value === "object" ? (
                  <pre className="spans-json">{JSON.stringify(value, null, 2)}</pre>
                ) : (
                  String(value)
                )}
              </Fact>
            ))}
          </Facts>
        )}
      </div>
    </div>
  );
}

function Facts({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="spans-group">
      <h4>{title}</h4>
      <dl>{children}</dl>
    </section>
  );
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt>{name}</dt>
      <dd className="mono">{children}</dd>
    </>
  );
}
