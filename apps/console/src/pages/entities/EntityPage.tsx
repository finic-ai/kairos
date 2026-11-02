import { useState } from "react";
import { displayName, displayOf } from "@kairos/core";
import { api } from "../../api/index";
import { ActionRef } from "../../components/actions/ActionRef";
import { Pill, Score } from "../../components/decisions/Outcome";
import { EditInfoModal } from "../../components/entities/EditInfoModal";
import { CommandCard } from "../../components/entities/Commands";
import { EntityFacts } from "../../components/entities/EntityFacts";
import { EntityLists } from "../../components/entities/EntityLists";
import { EntityIcon, TypeIcon } from "../../components/entities/EntityIcon";
import { LabelChips } from "../../components/entities/LabelChips";
import { PropertyValue } from "../../components/entities/PropertyValue";
import { Timeline } from "../../components/events/Timeline";
import { Card } from "../../components/ui/Card";
import { Chips } from "../../components/ui/Chips";
import { KV } from "../../components/ui/KV";
import { Failure, Loading } from "../../components/ui/states";
import { entityName, entityNames, stamp } from "../../lib/format";
import { useApi } from "../../hooks/useApi";
import { go, href } from "../../lib/route";
import { useEntityDefinitions } from "../../hooks/useEntityDefinitions";
import { useActionNames } from "../../hooks/useActionNames";

export function EntityPage({ type, id }: { type: string; id: string }) {
  const names = useActionNames();
  const { data: e, error, refetch: reload } = useApi(["entity", type, id], () => api.entity({ type, id }));
  const { data: definition } = useApi(["entity-type", type], () => api.entityType(type).catch(() => null));
  const definitions = useEntityDefinitions();
  const [label, setLabel] = useState("");
  const [editing, setEditing] = useState(false);
  const crumb = (
    <a className="crumb" href={href("entities", type)}>
      ← {entityNames(type)}
    </a>
  );
  if (error)
    return (
      <>
        {crumb}
        <Failure message={error.message} />
      </>
    );
  if (!e) return <Loading />;

  const addLabel = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!label.trim()) return;
    await api.label({ type, id }, label.trim());
    setLabel("");
    reload();
  };
  const events = e.events.map((ev) => {
    const { [type]: _self, ...others } = ev.entities;
    return {
      ...ev.properties,
      ...others,
      ...(ev.status ? { status: ev.status } : {}),
      ...(ev.universal_id ? { record: ev.universal_id } : {}),
      ts: ev.ts,
      type: ev.type,
    };
  });

  const connected = new Map<string, { type: string; id: string; events: number }>();
  for (const ev of e.events) {
    for (const [t, v] of Object.entries(ev.entities)) {
      if (t === type && v === id) continue;
      const key = `${t} ${v}`;
      connected.set(key, { type: t, id: v, events: (connected.get(key)?.events ?? 0) + 1 });
    }
  }
  const links = [...connected.values()].sort((a, b) => b.events - a.events);
  const display = displayOf(type, definition);
  const name = displayName(display.fields, e.properties);

  return (
    <>
      {crumb}
      <header className="page-head">
        <div>
          <div className="profile-head">
            <EntityIcon icon={display.icon} color={display.color} size="lg" title={entityName(type)} />
            <div>
              {name ? <h1>{name}</h1> : <h1 className="mono-title">{id}</h1>}
              {name && <div className="entity-id">{id}</div>}
            </div>
          </div>
          <div className="row wrap" style={{ marginTop: 10 }}>
            <span className="chip">{entityName(type)}</span>
            <LabelChips labels={e.labels.map((l) => l.label)} />
          </div>
        </div>
      </header>
      <div className="split detail">
        <div className="stack">
          <EntityFacts entity={{ type, id }} />
          {e.decisions.length > 0 && (
            <div className="card table-wrap o-hero">
              <table>
                <thead>
                  <tr>
                    <th>Outcome</th>
                    <th>Risk</th>
                    <th>Action</th>
                    <th className="hide-md">Signals</th>
                    <th style={{ textAlign: "right" }}>Decided</th>
                  </tr>
                </thead>
                <tbody>
                  {e.decisions.map((d) => (
                    <tr key={d.id} className="link" onClick={() => go("decisions", d.id)}>
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
                      <td className="mono muted" style={{ textAlign: "right" }}>
                        {stamp(d.ts)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <EntityLists entity={{ type, id }} lists={definition?.lists ?? []} />
          <CommandCard page="entity" groups={[{ entity: { type, id }, commands: definition?.commands }]} />
          <Card title={`History · last ${events.length} events, newest first`} className="o-timeline">
            {events.length ? (
              <Timeline events={events} entityTypes={new Set(e.events.flatMap((ev) => Object.keys(ev.entities)))} />
            ) : (
              <span className="muted">No events name this {entityName(type)}.</span>
            )}
          </Card>
        </div>

        <aside className="stack">
          <Card className="o-pending">
            <h2 className="card-title">
              Info
              <a
                href={href("entities", type, id)}
                className="edit-link"
                aria-label="Edit info"
                title="Edit"
                onClick={(ev) => {
                  ev.preventDefault();
                  setEditing(true);
                }}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M13.6 3.6a1.9 1.9 0 0 1 2.8 2.8L7.5 15.3 4 16l.7-3.5z" />
                  <path d="m12 5.2 2.8 2.8" />
                </svg>
              </a>
            </h2>
            <KV
              data={{ first_seen: e.first_seen ?? "never", ...e.properties }}
              render={(key, value) =>
                key in e.properties && definition?.display?.formats?.[key] ? (
                  <PropertyValue
                    entity={{ type, id }}
                    name={key}
                    value={value}
                    format={definition.display.formats[key]}
                  />
                ) : undefined
              }
            />
          </Card>
          {editing && (
            <EditInfoModal
              entity={{ type, id }}
              properties={e.properties}
              documented={Object.keys(definition?.properties ?? {})}
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false);
                reload();
              }}
            />
          )}
          <Card title={`Linked entities · ${links.length}`} className="o-links">
            {links.length === 0 ? (
              <span className="muted">Its events name no other entity.</span>
            ) : (
              <div className="linked-list">
                {links.slice(0, 40).map((l) => (
                  <a key={`${l.type} ${l.id}`} href={href("entities", l.type, l.id)}>
                    <TypeIcon type={l.type} definition={definitions[l.type]} size="sm" />
                    <span className="chip">{entityName(l.type)}</span>
                    <span className="mono grow">{l.id}</span>
                    <span className="mono muted">{l.events}</span>
                  </a>
                ))}
              </div>
            )}
            <p className="note" style={{ margin: "10px 0 0" }}>
              From its last {e.events.length} events, with the number of shared events.
              {links.length > 40 ? ` Showing 40 of ${links.length}.` : ""}
            </p>
          </Card>
          {e.sessions.length > 0 && (
            <Card title={`Sessions · ${e.sessions.length}`} className="o-links">
              <div className="linked-list">
                {e.sessions.map((s) => (
                  <a key={s.id} href={href("sessions", s.id)}>
                    <span className="mono grow">{s.id}</span>
                    <span className="mono muted">
                      {s.events} · {stamp(s.started)}
                    </span>
                  </a>
                ))}
              </div>
              <p className="note" style={{ margin: "10px 0 0" }}>
                The most recent sessions, with the number of its events in each and when the session started.
              </p>
            </Card>
          )}
          <Card title="Add a label" className="o-feedback">
            <form className="row" onSubmit={addLabel}>
              <input
                className="input mono grow"
                placeholder="fraud_confirmed"
                value={label}
                onChange={(ev) => setLabel(ev.target.value)}
              />
              <button className="btn">Add</button>
            </form>
            <p className="note" style={{ margin: "10px 0 0" }}>
              A label is a verdict or an outcome. Links to labelled entities show up in decisions.
            </p>
          </Card>
        </aside>
      </div>
    </>
  );
}
