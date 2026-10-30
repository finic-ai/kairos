import { useState } from "react";
import { api } from "../../api/index";
import type { KairosEvent } from "../../types/interfaces";
import { ActionRef } from "../../components/actions/ActionRef";
import { Pill, Score } from "../../components/decisions/Outcome";
import { Timeline } from "../../components/events/Timeline";
import { Card } from "../../components/ui/Card";
import { Chips } from "../../components/ui/Chips";
import { Empty, Failure, Loading } from "../../components/ui/states";
import { useActionNames } from "../../hooks/useActionNames";
import { useApi } from "../../hooks/useApi";
import { durationText, entityName, stamp } from "../../lib/format";
import { go, href } from "../../lib/route";
import { SessionReplay } from "../../components/sessions/SessionReplay";
import { SessionReplayDevice } from "../../components/sessions/SessionReplayDevice";

const plural = (type: string) => `${entityName(type)}${type.endsWith("s") ? "" : "s"}`;

const REPLAYS = [
  ["timeline", "Timeline"],
  ["device", "Device"],
] as const;

type ReplayKind = (typeof REPLAYS)[number][0];

const REPLAY_KEY = "kairos.replay";

export function SessionPage({ id }: { id?: string }) {
  const names = useActionNames();
  const [replay, setReplay] = useState<ReplayKind>(() => {
    try {
      return localStorage.getItem(REPLAY_KEY) === "device" ? "device" : "timeline";
    } catch {
      return "timeline";
    }
  });
  const chooseReplay = (kind: ReplayKind) => {
    setReplay(kind);
    try {
      localStorage.setItem(REPLAY_KEY, kind);
    } catch {}
  };
  const { data: s, error } = useApi(["session", id], () =>
    id ? api.session(id) : Promise.reject(new Error("Open a session from an entity or a decision.")),
  );
  if (error) return <Failure message={error.message} />;
  if (!s) return <Loading />;

  const started = Date.parse(s.started);
  const after = (ts: string) => {
    const seconds = Math.max(0, Math.round((Date.parse(ts) - started) / 1000));
    return `+${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const events: KairosEvent[] = [...s.events].reverse().map((ev) => ({
    ...ev.properties,
    ...ev.entities,
    ...(ev.status ? { status: ev.status } : {}),
    ...(ev.universal_id ? { record: ev.universal_id } : {}),
    after_start: after(ev.ts),
    ts: ev.ts,
    type: ev.type,
  }));
  const entities = Object.entries(s.entities).sort((a, b) => a[0].localeCompare(b[0]));
  const subjects = new Set(s.decisions.map((d) => d.subject.type));
  const shared = entities.filter(([type, ids]) => ids.length > 1 && (subjects.has(type) || type === "user"));

  return (
    <>
      <a className="crumb" href={href("sessions")}>
        ← Sessions
      </a>
      <header className="page-head">
        <div>
          <h1 className="mono-title">{s.id}</h1>
          <div className="row wrap" style={{ marginTop: 10 }}>
            <span className="chip">Session</span>
            {shared.map(([type, ids]) => (
              <span key={type} className="chip warn">
                {ids.length} {plural(type).toLowerCase()} in one session
              </span>
            ))}
          </div>
        </div>
      </header>
      <div className="split detail">
        <div className="stack">
          <div className="card pad session-facts">
            <dl className="facts">
              <div>
                <dt>Started</dt>
                <dd className="mono">{stamp(s.started)} UTC</dd>
              </div>
              <div>
                <dt>Lasted</dt>
                <dd>{durationText(Date.parse(s.last_seen) - started)}</dd>
              </div>
              <div>
                <dt>Events</dt>
                <dd className="mono">{s.events.length.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Decisions</dt>
                <dd className="mono">{s.decisions.length.toLocaleString()}</dd>
              </div>
            </dl>
          </div>
          <div className="replay-choice">
            <span className="muted">Replay</span>
            <div className="seg">
              {REPLAYS.map(([id, label]) => (
                <button key={id} className={replay === id ? "on" : ""} onClick={() => chooseReplay(id)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {replay === "device" ? (
            <SessionReplayDevice events={s.events} decisions={s.decisions} names={names} />
          ) : (
            <SessionReplay events={s.events} decisions={s.decisions} names={names} />
          )}
          {s.decisions.length > 0 && (
            <div className="card table-wrap">
              <div className="table-head">Decisions in this session</div>
              <table>
                <thead>
                  <tr>
                    <th>After start</th>
                    <th>Outcome</th>
                    <th>Risk</th>
                    <th>Action</th>
                    <th className="hide-md">Signals</th>
                    <th>About</th>
                  </tr>
                </thead>
                <tbody>
                  {s.decisions.map((d) => (
                    <tr key={d.id} className="link" onClick={() => go("decisions", d.id)}>
                      <td className="mono muted">{after(d.ts)}</td>
                      <td>
                        <Pill outcome={d.decision.decision} />
                      </td>
                      <td style={{ width: 150 }}>
                        <Score value={d.decision.risk_score} outcome={d.decision.decision} />
                      </td>
                      <td>
                        <ActionRef action={d.action} names={names} />
                      </td>
                      <td className="hide-md signals" style={{ maxWidth: 190 }}>
                        <Chips items={d.decision.reasons} max={1} />
                      </td>
                      <td className="mono">{d.subject.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Card
            title={`What happened · ${events.length} ${events.length === 1 ? "event" : "events"}, newest first`}
            className="o-timeline"
          >
            {events.length ? (
              <Timeline events={events} entityTypes={new Set(Object.keys(s.entities))} />
            ) : (
              <Empty title="No events">The decisions of this session came with no events.</Empty>
            )}
          </Card>
        </div>

        <aside className="stack">
          <Card title="Who and what" className="o-links">
            {entities.length === 0 ? (
              <span className="muted">Its events name no entity.</span>
            ) : (
              <div className="linked-list">
                {entities.flatMap(([type, ids]) =>
                  ids.slice(0, 20).map((entity) => (
                    <a key={`${type} ${entity}`} href={href("entities", type, entity)}>
                      <span className="chip">{entityName(type)}</span>
                      <span className="mono grow">{entity}</span>
                    </a>
                  )),
                )}
              </div>
            )}
            <p className="note" style={{ margin: "10px 0 0" }}>
              Every entity that an event of this session names.
            </p>
          </Card>
          <Card title="About sessions">
            <p className="note" style={{ margin: 0 }}>
              A session is the events sent with the same <span className="mono">$session</span>: one visit of a person.
              A decision made in a session sees what happened in it before the request.
            </p>
          </Card>
        </aside>
      </div>
    </>
  );
}
