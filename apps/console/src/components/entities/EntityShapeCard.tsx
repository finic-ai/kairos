import type { EntityShape } from "../../types/interfaces";
import { LabelChips } from "./LabelChips";
import { Card } from "../ui/Card";
import { previewValue } from "../../lib/format";

export function EntityShapeCard({
  shape,
  documented,
  onAdd,
}: {
  shape: EntityShape;
  documented: string[];
  onAdd: (name: string) => void;
}) {
  const empty = shape.properties.length === 0 && shape.events.length === 0;
  return (
    <Card title="Current shape">
      {empty ? (
        <p className="note" style={{ margin: 0 }}>
          No entity of this type is recorded yet. The shape appears when events name it or when it is given properties.
        </p>
      ) : (
        <div className="stack" style={{ gap: 18 }}>
          <div>
            <div className="sub-title">Properties</div>
            {shape.properties.length === 0 ? (
              <p className="note" style={{ margin: 0 }}>
                No properties are set on entities of this type. They exist only because events name them.
              </p>
            ) : (
              <>
                <div className="shape">
                  {shape.properties.map((p) => (
                    <div key={p.name}>
                      <span className="mono name">{p.name}</span>
                      <span className="mono muted">{p.types.join(" | ")}</span>
                      <span className="mono muted example">{previewValue(p.example)}</span>
                      <span className="muted share">{Math.round((p.seen / shape.sampled) * 100)}%</span>
                      {documented.includes(p.name) ? (
                        <span className="chip accent">documented</span>
                      ) : (
                        <button type="button" className="btn ghost" onClick={() => onAdd(p.name)}>
                          Document
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <p className="note" style={{ margin: "10px 0 0" }}>
                  Type, an example value, and the share of entities that carry the property.{" "}
                  {shape.sampled < shape.with_properties
                    ? `Read from the ${shape.sampled.toLocaleString()} most recently updated of ${shape.with_properties.toLocaleString()} entities.`
                    : `Read from ${shape.sampled.toLocaleString()} ${shape.sampled === 1 ? "entity" : "entities"}.`}
                </p>
              </>
            )}
          </div>
          {shape.events.length > 0 && (
            <div>
              <div className="sub-title">Named by these events</div>
              <div className="chips">
                {shape.events.map((e) => (
                  <span key={e.type} className="chip">
                    {e.type} · {e.count.toLocaleString()}
                  </span>
                ))}
              </div>
            </div>
          )}
          {shape.labels.length > 0 && (
            <div>
              <div className="sub-title">Labels in use</div>
              <LabelChips labels={shape.labels.map((l) => l.label)} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
