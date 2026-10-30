import { useEffect, useMemo, useState } from "react";
import type { DecisionSummary } from "../../types/interfaces";
import type { Outcome, StoredEvent } from "../../types/interfaces";
import { ActionRef } from "../actions/ActionRef";
import { Chips } from "../ui/Chips";
import { entityName } from "../../lib/format";
import { OUTCOME_LABEL } from "../../lib/outcomes";
import { href } from "../../lib/route";

/**
 * A second way to replay a session, beside `SessionReplay`: the session as it might have
 * looked on the person's device. Each event becomes a screen, and a decision of Kairos comes
 * over it. Beside the device, the entities the session has touched so far appear as they are
 * first used. It is drawn from the events: it is not a recording of a screen.
 */
type Step =
  { kind: "event"; at: number; event: StoredEvent } | { kind: "decision"; at: number; decision: DecisionSummary };

const SPEEDS = [0.5, 1, 2, 4];
const MIN_MS = 1300;
const MAX_MS = 3600;
const pause = (gapMs: number) => Math.min(MAX_MS, MIN_MS + 700 * Math.log10(1 + gapMs / 1000));

const after = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `+${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(seconds % 60).padStart(2, "0")}`;
};
const wait = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "";
  if (seconds < 90) return `${seconds} ${seconds === 1 ? "second" : "seconds"} later`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} minutes later` : `${Math.round(minutes / 60)} hours later`;
};
const wall = (at: number) => new Date(at).toISOString().slice(11, 19);
const words = (text: string) => text.replaceAll("_", " ");
const shown = (value: unknown) => (value === null || typeof value !== "object" ? String(value) : JSON.stringify(value));

export function SessionReplayDevice({
  events,
  decisions,
  names,
}: {
  events: StoredEvent[];
  decisions: DecisionSummary[];
  names: Record<string, string>;
}) {
  const steps = useMemo<Step[]>(() => {
    const all: Step[] = [
      ...events.map((event): Step => ({ kind: "event", at: Date.parse(event.ts), event })),
      ...decisions.map((decision): Step => ({ kind: "decision", at: Date.parse(decision.ts), decision })),
    ];
    return all.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "event" ? -1 : 1));
  }, [events, decisions]);
  const { offsets, total } = useMemo(() => {
    const offsets = [0];
    for (let i = 1; i < steps.length; i++) offsets.push(offsets[i - 1]! + pause(steps[i]!.at - steps[i - 1]!.at));
    return { offsets, total: (offsets[offsets.length - 1] ?? 0) + MIN_MS };
  }, [steps]);

  const still = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, []);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [begun, setBegun] = useState(false);

  useEffect(() => {
    if (!playing) return;
    if (still) {
      const timer = setInterval(() => setPosition((p) => offsets.find((o) => o > p + 1) ?? total), 1600 / speed);
      return () => clearInterval(timer);
    }
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const passed = (now - last) * speed;
      last = now;
      setPosition((p) => Math.min(total, p + passed));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, still, offsets, total]);
  useEffect(() => {
    if (position >= total) setPlaying(false);
  }, [position, total]);

  let current = -1;
  if (begun) for (let i = 0; i < offsets.length; i++) if (offsets[i]! <= position + 1) current = i;
  const step = steps[current];
  const first = steps[0]?.at ?? 0;
  const ended = position >= total;

  // The screen stays the last event while a decision is over it.
  let screen: StoredEvent | undefined;
  for (let i = current; i >= 0 && !screen; i--)
    if (steps[i]!.kind === "event") screen = (steps[i] as Extract<Step, { kind: "event" }>).event;
  const verdict = step?.kind === "decision" ? step.decision : undefined;

  const cast = useMemo(() => {
    const seen = new Map<string, { type: string; id: string; first: number; last: number; uses: number }>();
    for (let i = 0; i <= current; i++) {
      const s = steps[i]!;
      const named =
        s.kind === "event"
          ? Object.entries(s.event.entities)
          : [[s.decision.subject.type, s.decision.subject.id] as [string, string]];
      for (const [type, id] of named) {
        const key = `${type} ${id}`;
        const entry = seen.get(key) ?? { type, id, first: i, last: i, uses: 0 };
        seen.set(key, { ...entry, last: i, uses: entry.uses + (s.kind === "event" ? 1 : 0) });
      }
    }
    return [...seen.values()];
  }, [steps, current]);
  const decided = steps
    .slice(0, current + 1)
    .filter((s): s is Extract<Step, { kind: "decision" }> => s.kind === "decision");

  if (steps.length === 0) return null;
  const toggle = () => {
    if (ended) setPosition(0);
    setBegun(true);
    setPlaying(!playing || ended);
  };
  const tone = (outcome: Outcome) => `t-${outcome}`;
  const rows = screen ? Object.entries(screen.properties).slice(0, 6) : [];
  const others = screen ? Object.entries(screen.entities) : [];

  return (
    <section className="card device-replay" aria-label="Session replay, as a device">
      <div className="device-grid">
        <div className="device-wrap">
          <div className={`device ${verdict ? "has-verdict" : ""}`}>
            <div className="device-status">
              <span className="mono">{step ? wall(step.at) : "--:--:--"}</span>
              <span className="device-notch" aria-hidden />
              <span className="mono">{step ? after(step.at - first) : "+0:00"}</span>
            </div>
            <div className="device-screen">
              {!screen ? (
                <div className="device-idle">
                  <div className="device-idle-mark" aria-hidden>
                    <svg viewBox="0 0 16 16" width="18" height="18">
                      <path d="M4.5 2.5v11l9-5.500z" fill="currentColor" />
                    </svg>
                  </div>
                  <p>Play to watch the session as a sequence of screens.</p>
                </div>
              ) : (
                <div key={screen.id} className="device-page">
                  <div className="device-page-head">
                    <span className="device-avatar" aria-hidden>
                      {words(screen.type).slice(0, 1)}
                    </span>
                    <div>
                      <h3>{words(screen.type)}</h3>
                      {screen.status && <span className="chip">{screen.status}</span>}
                    </div>
                  </div>
                  <dl className="device-rows">
                    {others.map(([type, id]) => (
                      <div key={type}>
                        <dt>{entityName(type)}</dt>
                        <dd className="mono">{id}</dd>
                      </div>
                    ))}
                    {rows.map(([name, value]) => (
                      <div key={name}>
                        <dt>{words(name)}</dt>
                        <dd className="mono">{shown(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="device-action" aria-hidden>
                    <span>{words(screen.type)}</span>
                    <i className="device-tap" />
                  </div>
                </div>
              )}
              {verdict && (
                <div key={verdict.id} className={`device-verdict ${tone(verdict.decision.decision)}`}>
                  <span className="device-verdict-by">Kairos decided</span>
                  <strong>{OUTCOME_LABEL[verdict.decision.decision]}</strong>
                  <span className="device-verdict-risk mono">risk {verdict.decision.risk_score}</span>
                  <span className="device-verdict-action">
                    <ActionRef action={verdict.action} names={names} />
                  </span>
                </div>
              )}
            </div>
            <div className="device-home" aria-hidden />
          </div>
        </div>

        <div className="device-side">
          <div className="device-caption">
            <div className="device-clock mono">{step ? after(step.at - first) : "+0:00"}</div>
            <div className="muted">
              {!step
                ? `${steps.length} steps`
                : `Step ${current + 1} of ${steps.length}${current > 0 && wait(step.at - steps[current - 1]!.at) ? ` · ${wait(step.at - steps[current - 1]!.at)}` : ""}`}
            </div>
          </div>

          <div className="device-panel">
            <h4>In this session so far</h4>
            {cast.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Nothing yet.
              </p>
            ) : (
              <ul className="device-cast">
                {cast.map((c) => (
                  <li
                    key={`${c.type} ${c.id}`}
                    className={`${c.last === current ? "used" : ""} ${c.first === current ? "new" : ""}`}
                  >
                    <a href={href("entities", c.type, c.id)}>
                      <span className="chip">{entityName(c.type)}</span>
                      <span className="mono grow">{c.id}</span>
                      {c.first === current ? (
                        <span className="device-new">first use</span>
                      ) : (
                        <span className="mono muted">{c.uses}</span>
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {decided.length > 0 && (
            <div className="device-panel">
              <h4>Decided so far</h4>
              {decided.map((d) => (
                <a
                  key={d.decision.id}
                  className={`device-decided ${tone(d.decision.decision.decision)}`}
                  href={href("decisions", d.decision.id)}
                >
                  <span className="mono muted">{after(d.at - first)}</span>
                  <strong>{OUTCOME_LABEL[d.decision.decision.decision]}</strong>
                  <span className="mono">risk {d.decision.decision.risk_score}</span>
                </a>
              ))}
              {verdict && verdict.decision.reasons.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <Chips items={verdict.decision.reasons} max={6} />
                </div>
              )}
            </div>
          )}
          <p className="note device-note">
            Drawn from the events of the session. It is not a recording of the person's screen.
          </p>
        </div>

        <div className="device-controls">
          <button
            className="btn primary device-play"
            onClick={toggle}
            aria-label={playing ? "Pause" : ended ? "Play again" : "Play"}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
              {playing ? (
                <path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" />
              ) : (
                <path d="M4.5 2.5v11l9-5.500z" fill="currentColor" />
              )}
            </svg>
            {playing ? "Pause" : ended ? "Play again" : begun ? "Resume" : "Play"}
          </button>
          <input
            className="device-scrub"
            type="range"
            min={0}
            max={Math.round(total)}
            value={Math.round(position)}
            aria-label="Position in the replay"
            aria-valuetext={step ? `Step ${current + 1} of ${steps.length}` : "Start"}
            style={{ "--played": `${(100 * position) / total}%` } as React.CSSProperties}
            onChange={(e) => (setBegun(true), setPlaying(false), setPosition(Number(e.target.value)))}
          />
          <select
            className="input device-speed"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            aria-label="Replay speed"
          >
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </div>
      </div>
    </section>
  );
}
