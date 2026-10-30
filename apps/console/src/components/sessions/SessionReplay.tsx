import { useEffect, useMemo, useRef, useState } from "react";
import type { DecisionSummary } from "../../types/interfaces";
import type { Outcome, StoredEvent } from "../../types/interfaces";
import { ActionRef } from "../actions/ActionRef";
import { Chips } from "../ui/Chips";
import { Pill } from "../decisions/Outcome";
import { entityName } from "../../lib/format";
import { OUTCOME_LABEL } from "../../lib/outcomes";
import { href } from "../../lib/route";

type Step =
  { kind: "event"; at: number; event: StoredEvent } | { kind: "decision"; at: number; decision: DecisionSummary };

const SPEEDS = [0.5, 1, 2, 4];
const MIN_MS = 900;
const MAX_MS = 3200;

const pause = (gapMs: number) => Math.min(MAX_MS, MIN_MS + 700 * Math.log10(1 + gapMs / 1000));

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `+${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(seconds % 60).padStart(2, "0")}`;
};
const gap = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return "at the same moment";
  if (seconds < 90) return `${seconds} ${seconds === 1 ? "second" : "seconds"} later`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes later`;
  return `${Math.round(minutes / 60)} hours later`;
};
const words = (text: string) => text.replaceAll("_", " ");
const shown = (value: unknown) => (value === null || typeof value !== "object" ? String(value) : JSON.stringify(value));

/**
 * The session played back: each event and decision in the order it happened, with the time
 * after the start. Long waits are shortened, so a visit of an hour plays in under a minute;
 * the clock still shows the real time.
 */
export function SessionReplay({
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
    // At the same moment, the event comes before the decision it started.
    return all.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "event" ? -1 : 1));
  }, [events, decisions]);

  // Where each step is on the track: the replay's own time, so that the playhead moves evenly.
  const { offsets, total } = useMemo(() => {
    const offsets = [0];
    for (let i = 1; i < steps.length; i++) offsets.push(offsets[i - 1]! + pause(steps[i]!.at - steps[i - 1]!.at));
    return { offsets, total: (offsets[offsets.length - 1] ?? 0) + MIN_MS };
  }, [steps]);

  const still = useMemo(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false, []);
  const [position, setPosition] = useState(0); // in the replay's time
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [begun, setBegun] = useState(false);
  const list = useRef<HTMLOListElement>(null);

  // The playhead moves while playing. With reduced motion, it goes from step to step.
  useEffect(() => {
    if (!playing) return;
    if (still) {
      const timer = setInterval(
        () =>
          setPosition((p) => {
            const next = offsets.find((o) => o > p + 1);
            if (next === undefined) return total;
            return next;
          }),
        1400 / speed,
      );
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

  // The real time at the playhead: it runs between two steps as the playhead moves between them.
  const first = steps[0]?.at ?? 0;
  let real = 0;
  if (current >= 0) {
    const next = steps[current + 1];
    const share = next ? Math.min(1, (position - offsets[current]!) / (offsets[current + 1]! - offsets[current]!)) : 0;
    real = steps[current]!.at - first + (next ? share * (next.at - steps[current]!.at) : 0);
  }

  useEffect(() => {
    const row = list.current?.lastElementChild as HTMLElement | null;
    if (row && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [current]);

  if (steps.length === 0) return null;
  const ended = position >= total;
  const toggle = () => {
    if (ended) setPosition(0);
    setBegun(true);
    setPlaying(!playing || ended);
  };
  const seek = (index: number) => (
    setBegun(true),
    setPosition(offsets[Math.max(0, Math.min(steps.length - 1, index))]!)
  );
  const tone = (s: Step): Outcome | undefined => (s.kind === "decision" ? s.decision.decision.decision : undefined);
  const title = (s: Step) =>
    s.kind === "event"
      ? words(s.event.type)
      : `Decision: ${names[s.decision.action.split("@")[0]!] ?? words(s.decision.action.split("@")[0]!)}`;

  return (
    <section
      className="card replay"
      aria-label="Session replay"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).tagName === "SELECT") return;
        if (e.key === "ArrowRight") (e.preventDefault(), setPlaying(false), seek(current + 1));
        if (e.key === "ArrowLeft") (e.preventDefault(), setPlaying(false), seek(current - 1));
      }}
    >
      <div className="replay-bar">
        <button
          className="btn primary replay-play"
          onClick={toggle}
          aria-label={playing ? "Pause" : ended ? "Play again" : "Play"}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            {playing ? (
              <path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" />
            ) : ended ? (
              <path
                d="M8 3a5 5 0 1 0 4.6 3M8 1v4l3-2z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            ) : (
              <path d="M4.5 2.5v11l9-5.500z" fill="currentColor" />
            )}
          </svg>
          {playing ? "Pause" : ended ? "Play again" : begun ? "Resume" : "Play"}
        </button>
        <span className="replay-clock mono" aria-live="off">
          {clock(real)}
        </span>
        <span className="muted replay-count">
          {current + 1} of {steps.length}
        </span>
        <span className="grow" />
        <label className="replay-speed">
          <span className="muted">Speed</span>
          <select
            className="input"
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
        </label>
      </div>

      <div className="replay-track" role="group" aria-label="Steps of the session">
        <div className="replay-line" />
        <div
          className="replay-done"
          style={{
            width: `${(100 * Math.min(position, offsets[offsets.length - 1]!)) / (offsets[offsets.length - 1] || 1)}%`,
          }}
        />
        {steps.map((s, i) => (
          <button
            key={i}
            className={`replay-dot ${s.kind} ${tone(s) ? `t-${tone(s)}` : ""} ${i <= current ? "past" : ""} ${i === current ? "now" : ""}`}
            style={{ left: `${(100 * offsets[i]!) / (offsets[offsets.length - 1] || 1)}%` }}
            title={`${clock(s.at - first)} ${title(s)}`}
            aria-label={`Go to step ${i + 1}: ${title(s)}, ${clock(s.at - first)}`}
            aria-current={i === current ? "step" : undefined}
            onClick={() => (setPlaying(false), seek(i))}
          />
        ))}
      </div>

      <div className="replay-stage">
        {!step ? (
          <div className="replay-idle muted">
            Play the session to see what happened, step by step. Long waits are shortened. The clock shows the real time
            after the start.
          </div>
        ) : (
          <div key={current} className={`replay-now ${step.kind} ${tone(step) ? `t-${tone(step)}` : ""}`}>
            <div className="replay-when">
              <span className="mono">{clock(step.at - first)}</span>
              {current > 0 && <span className="muted">{gap(step.at - steps[current - 1]!.at)}</span>}
            </div>
            {step.kind === "event" ? (
              <>
                <h3>
                  {words(step.event.type)}
                  {step.event.status && <span className="chip">{step.event.status}</span>}
                </h3>
                <div className="replay-facts">
                  {Object.entries(step.event.entities).map(([type, id]) => (
                    <a key={type} className="replay-fact" href={href("entities", type, id)}>
                      <i>{entityName(type)}</i>
                      <span className="mono">{id}</span>
                    </a>
                  ))}
                  {Object.entries(step.event.properties)
                    .slice(0, 8)
                    .map(([name, value]) => (
                      <span key={name} className="replay-fact">
                        <i>{words(name)}</i>
                        <span className="mono">{shown(value)}</span>
                      </span>
                    ))}
                </div>
              </>
            ) : (
              <>
                <h3>
                  <Pill outcome={step.decision.decision.decision} large />
                  <span className="replay-risk mono">risk {step.decision.decision.risk_score}</span>
                </h3>
                <div className="replay-facts">
                  <a className="replay-fact" href={href("decisions", step.decision.id)}>
                    <i>Decision</i>
                    <span>
                      <ActionRef action={step.decision.action} names={names} />
                    </span>
                  </a>
                  <a
                    className="replay-fact"
                    href={href("entities", step.decision.subject.type, step.decision.subject.id)}
                  >
                    <i>{entityName(step.decision.subject.type)}</i>
                    <span className="mono">{step.decision.subject.id}</span>
                  </a>
                </div>
                {step.decision.decision.reasons.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <Chips items={step.decision.decision.reasons} max={6} />
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {current >= 0 && (
        <ol className="replay-log" ref={list} aria-label="What happened so far">
          {steps.slice(0, current + 1).map((s, i) => (
            <li key={i} className={`${s.kind} ${tone(s) ? `t-${tone(s)}` : ""} ${i === current ? "now" : ""}`}>
              <button onClick={() => (setPlaying(false), seek(i))}>
                <span className="mono muted">{clock(s.at - first)}</span>
                <i />
                <span>{title(s)}</span>
                {s.kind === "decision" && (
                  <span className="replay-outcome">{OUTCOME_LABEL[s.decision.decision.decision]}</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
