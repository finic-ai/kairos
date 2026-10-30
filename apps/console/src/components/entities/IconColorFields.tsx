import { ENTITY_COLORS, ENTITY_ICONS, type EntityColor, type EntityIcon as IconName } from "@kairos/core";
import { EntityIcon } from "./EntityIcon";

/**
 * The choice of an icon and a colour, as entity types and queues have. Choosing the fallback
 * again clears the choice, so the item follows its default if that changes.
 */
export function IconColorFields({
  icon,
  color,
  fallback,
  note,
  onChange,
}: {
  icon: IconName | "";
  color: EntityColor | "";
  fallback: { icon: IconName; color: EntityColor };
  note?: string;
  onChange: (patch: { icon?: IconName | ""; color?: EntityColor | "" }) => void;
}) {
  const shownIcon = icon || fallback.icon;
  const shownColor = color || fallback.color;
  return (
    <>
      <div className="field">
        <span>Icon</span>
        <div className="icon-choices">
          {ENTITY_ICONS.map((name) => (
            <button
              key={name}
              type="button"
              className={`icon-choice ${shownIcon === name ? "on" : ""}`}
              aria-label={name}
              title={name}
              onClick={() => onChange({ icon: name === fallback.icon ? "" : name })}
            >
              <EntityIcon icon={name} color={shownColor} />
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <span>Colour</span>
        <div className="color-choices">
          {ENTITY_COLORS.map((name) => (
            <button
              key={name}
              type="button"
              className={`color-choice ${shownColor === name ? "on" : ""}`}
              aria-label={name}
              title={name}
              onClick={() => onChange({ color: name === fallback.color ? "" : name })}
            >
              <span className={`swatch ent-${name}`} />
            </button>
          ))}
        </div>
        {note && <small>{note}</small>}
      </div>
    </>
  );
}
