import { displayName, displayOf } from "@kairos/core";
import type { ReactNode } from "react";
import { api, queues } from "../../api/index";
import { useActionNames } from "../../hooks/useActionNames";
import { useApi } from "../../hooks/useApi";
import { useEntityDefinitions } from "../../hooks/useEntityDefinitions";
import { entityName, stamp } from "../../lib/format";
import { CATEGORY_LABEL, PRIORITY_LABEL, STATUS_LABEL } from "../../lib/queues";
import { href } from "../../lib/route";
import type { Outcome, RowLink } from "../../types/interfaces";
import { ActionRef } from "../actions/ActionRef";
import { Pill, Score } from "../decisions/Outcome";
import { Chips } from "../ui/Chips";
import { KV } from "../ui/KV";
import { Modal } from "../ui/Modal";
import { Failure, Loading } from "../ui/states";
import { LabelChips } from "./LabelChips";
import { PropertyValue } from "./PropertyValue";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="record-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Foot({ open, onClose }: { open: { href: string; label: string }[]; onClose: () => void }) {
  return (
    <div className="modal-foot">
      <button className="btn ghost" onClick={onClose}>
        Close
      </button>
      {open.map((o, i) => (
        <a key={o.href} className={`btn ${i === open.length - 1 ? "primary" : ""}`} href={o.href}>
          {o.label}
        </a>
      ))}
    </div>
  );
}

function EventRecord({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: e, error } = useApi(["event", id], () => api.event(id));
  if (error) return <Failure message={error.message} />;
  if (!e) return <Loading />;
  return (
    <>
      <KV
        data={{
          when: `${stamp(e.ts)} UTC`,
          event: e.type,
          status: e.status,
          session: e.session,
          record: e.universal_id,
        }}
      />
      {e.decision && (
        <Section title="The decision it started">
          <div className="row">
            <Pill outcome={e.decision.outcome as Outcome} />
            <div style={{ width: 160 }}>
              <Score value={e.decision.risk_score} outcome={e.decision.outcome as Outcome} />
            </div>
          </div>
        </Section>
      )}
      <Section title="Entities it names">
        <KV data={e.entities} entityTypes={new Set(Object.keys(e.entities))} />
      </Section>
      <Section title="Properties">
        <KV data={e.properties} />
      </Section>
      <Foot
        open={[
          ...(e.session ? [{ href: href("sessions", e.session), label: "Open the session" }] : []),
          ...(e.decision ? [{ href: href("decisions", e.decision.id), label: "Open the decision" }] : []),
        ]}
        onClose={onClose}
      />
    </>
  );
}

function DecisionRecord({ id, onClose }: { id: string; onClose: () => void }) {
  const names = useActionNames();
  const { data: d, error } = useApi(["decision", id], () => api.decision(id));
  if (error) return <Failure message={error.message} />;
  if (!d) return <Loading />;
  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <Pill outcome={d.decision.decision} />
        <div style={{ width: 160 }}>
          <Score value={d.decision.risk_score} outcome={d.decision.decision} />
        </div>
        <ActionRef action={d.action} names={names} />
      </div>
      <KV
        data={{
          when: `${stamp(d.ts)} UTC`,
          subject: `${entityName(d.subject.type)} ${d.subject.id}`,
          resolution: d.resolution
            ? `${d.resolution.outcome === "approve" ? "Approved" : "Blocked"}${d.resolution.note ? `: ${d.resolution.note}` : ""}`
            : "Not resolved",
        }}
      />
      {d.decision.reasons.length > 0 && (
        <Section title="Signals">
          <Chips items={d.decision.reasons} />
        </Section>
      )}
      <Foot open={[{ href: href("decisions", d.id), label: "Open the decision" }]} onClose={onClose} />
    </>
  );
}

function EntityRecord({ type, id, onClose }: { type: string; id: string; onClose: () => void }) {
  const definitions = useEntityDefinitions();
  const { data: e, error } = useApi(["entity", type, id], () => api.entity({ type, id }));
  if (error) return <Failure message={error.message} />;
  if (!e) return <Loading />;
  const name = displayName(displayOf(type, definitions[type]).fields, e.properties);
  return (
    <>
      {name && <div className="record-name">{name}</div>}
      {e.labels.length > 0 && (
        <div className="row wrap" style={{ marginBottom: 12 }}>
          <LabelChips labels={e.labels.map((l) => l.label)} />
        </div>
      )}
      <KV
        data={{ first_seen: e.first_seen ? `${stamp(e.first_seen)} UTC` : "never", ...e.properties }}
        render={(key, value) => {
          const format = definitions[type]?.display?.formats?.[key];
          return key in e.properties && format ? (
            <PropertyValue entity={{ type, id }} name={key} value={value} format={format} />
          ) : undefined;
        }}
      />
      <Foot
        open={[{ href: href("entities", type, id), label: `Open the ${entityName(type).toLowerCase()}` }]}
        onClose={onClose}
      />
    </>
  );
}

function CaseRecord({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: c, error } = useApi(["case", id], () => queues.case(id));
  if (error) return <Failure message={error.message} />;
  if (!c) return <Loading />;
  return (
    <>
      <KV
        data={{
          queue: c.queue.name,
          status: STATUS_LABEL[c.status],
          priority: PRIORITY_LABEL[c.priority],
          assignee: c.assignee?.name ?? "Nobody",
          why: c.reason,
          opened: `${stamp(c.created)} UTC`,
          resolution: c.resolution
            ? `${CATEGORY_LABEL[c.resolution.category]}${c.resolution.note ? `: ${c.resolution.note}` : ""}`
            : undefined,
        }}
      />
      <Foot open={[{ href: href("cases", c.id), label: "Open the case" }]} onClose={onClose} />
    </>
  );
}

const TITLE: Record<RowLink["kind"], string> = { event: "Event", decision: "Decision", entity: "", case: "Case" };

export function RecordModal({ link, onClose }: { link: RowLink; onClose: () => void }) {
  return (
    <Modal
      title={link.kind === "entity" ? `${entityName(link.type)} ${link.id}` : `${TITLE[link.kind]} ${link.id}`}
      onClose={onClose}
    >
      <div className="modal-body record-modal">
        {link.kind === "event" ? (
          <EventRecord id={link.id} onClose={onClose} />
        ) : link.kind === "decision" ? (
          <DecisionRecord id={link.id} onClose={onClose} />
        ) : link.kind === "entity" ? (
          <EntityRecord type={link.type} id={link.id} onClose={onClose} />
        ) : (
          <CaseRecord id={link.id} onClose={onClose} />
        )}
      </div>
    </Modal>
  );
}
