import { useState } from "react";
import { endStepDrag, startStepDrag, STEP_DRAG_TYPE } from "../../lib/workflowDrag";
import { STEP_GROUPS, STEP_KINDS } from "../../lib/workflows";
import { StepIcon } from "./StepIcon";

/** The steps a person can add: pick one for the chosen place, or drag one onto the canvas. */
export function StepPalette({
  where,
  deepest,
  onPick,
  onClose,
}: {
  /** Where a picked step goes, in words. */
  where: string;
  /** True when the place is at the deepest level: conditions and loops do not fit there. */
  deepest: boolean;
  onPick: (type: string) => void;
  onClose?: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = STEP_KINDS.filter((k) => `${k.label} ${k.about}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="wf-panel">
      <div className="wf-panel-head">
        <b>Add a step</b>
        {onClose && (
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        )}
      </div>
      <div className="wf-panel-body">
        <p className="muted wf-panel-note">Click a step to add it {where}, or drag it onto any + on the canvas.</p>
        <input
          className="input search"
          placeholder="Search steps"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        {STEP_GROUPS.map((group) => {
          const items = shown.filter((k) => k.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="wf-palette-group">
              <div className="wf-palette-title">{group}</div>
              {items.map((k) => {
                const blocked = deepest && (k.type === "condition" || k.type === "loop");
                return (
                  <button
                    key={k.type}
                    type="button"
                    className="wf-palette-item"
                    draggable={!blocked}
                    disabled={blocked}
                    title={blocked ? "Conditions and loops nest at most 3 levels." : k.about}
                    onClick={() => onPick(k.type)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(STEP_DRAG_TYPE, k.type);
                      e.dataTransfer.effectAllowed = "copy";
                      startStepDrag(k.type);
                    }}
                    onDragEnd={endStepDrag}
                  >
                    <StepIcon icon={k.icon} />
                    <span>
                      <b>{k.label}</b>
                      <small>{k.about}</small>
                    </span>
                    <span className="wf-grip" aria-hidden="true">
                      ⋮⋮
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
