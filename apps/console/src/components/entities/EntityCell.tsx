import type { EntityColor, EntityIcon as IconName } from "@kairos/core";
import { EntityIcon } from "./EntityIcon";

export function EntityCell({
  id,
  name,
  display,
}: {
  id: string;
  name: string | undefined;
  display: { icon: IconName; color: EntityColor };
}) {
  return (
    <div className="entity-cell">
      <EntityIcon icon={display.icon} color={display.color} size="sm" />
      {name ? (
        <div>
          <div className="entity-label">{name}</div>
          <div className="entity-id">{id}</div>
        </div>
      ) : (
        <span className="mono">{id}</span>
      )}
    </div>
  );
}
