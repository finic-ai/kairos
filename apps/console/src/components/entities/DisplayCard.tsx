import { displayName, displayOf, type EntityColor, type EntityIcon as IconName } from "@kairos/core";
import { EntityIcon } from "./EntityIcon";
import { IconColorFields } from "./IconColorFields";
import { Card } from "../ui/Card";

export function DisplayCard({
  type,
  kind,
  icon,
  color,
  fields,
  known,
  examples,
  onChange,
}: {
  type: string;
  kind: string;
  icon: IconName | "";
  color: EntityColor | "";
  fields: string[];
  known: string[];
  examples: Record<string, unknown>;
  onChange: (patch: { icon?: IconName | ""; color?: EntityColor | ""; fields?: string[] }) => void;
}) {
  const fallback = displayOf(type || "entity", kind ? { kind } : undefined);
  const shownIcon = icon || fallback.icon;
  const shownColor = color || fallback.color;
  const example = displayName(fields, examples);
  const addable = known.filter((name) => !fields.includes(name));
  return (
    <Card title="Display">
      <div className="stack" style={{ gap: 16 }}>
        <div className="display-preview">
          <EntityIcon icon={shownIcon} color={shownColor} size="lg" />
          <div>
            <div className="entity-label">{example ?? (fields.length ? "—" : `${type || "entity"}_123`)}</div>
            {fields.length > 0 && <div className="entity-id">{type || "entity"}_123</div>}
          </div>
        </div>
        <IconColorFields
          icon={icon}
          color={color}
          fallback={fallback}
          note="Without a choice, the icon and the colour of its kind."
          onChange={onChange}
        />
        <div className="field">
          <span>Display name</span>
          <div className="display-fields">
            {fields.map((name, i) => (
              <span key={name} className="chip accent">
                {name}
                <button
                  type="button"
                  className="chip-x"
                  aria-label={`Remove ${name}`}
                  onClick={() => onChange({ fields: fields.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </span>
            ))}
            {fields.length < 4 && (
              <select
                className="input"
                aria-label="Add a property to the display name"
                value=""
                onChange={(e) => e.target.value && onChange({ fields: [...fields, e.target.value] })}
              >
                <option value="">{fields.length ? "+ Add a property" : "Choose a property"}</option>
                {addable.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <small>
            One property, or up to four joined by a space, such as first_name and last_name. An entity that has none of
            them shows its id.
          </small>
        </div>
      </div>
    </Card>
  );
}
