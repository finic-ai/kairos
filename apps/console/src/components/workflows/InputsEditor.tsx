import { INPUT_TYPES } from "../../lib/workflows";
import type { WorkflowInput } from "../../types/interfaces";

/** A default can be set in the panel for the simple types. A list or an object comes with the run. */
const SIMPLE = new Set(["text", "number", "boolean", "entity"]);

function freshName(inputs: WorkflowInput[]) {
  let n = inputs.length + 1;
  while (inputs.some((i) => i.name === `input_${n}`)) n++;
  return `input_${n}`;
}

/** The inputs of a manual trigger: what a person, or the API, gives each run. */
export function InputsEditor({
  inputs,
  entityTypes,
  onChange,
}: {
  inputs: WorkflowInput[];
  entityTypes: string[];
  onChange: (inputs: WorkflowInput[]) => void;
}) {
  const change = (index: number, next: Partial<WorkflowInput>) =>
    onChange(
      inputs.map((input, i) => {
        if (i !== index) return input;
        const merged: WorkflowInput = { ...input, ...next };
        // Each type keeps only its own fields.
        if (next.type && next.type !== input.type) {
          delete merged.default;
          if (next.type !== "entity") delete merged.entity;
        }
        for (const key of Object.keys(merged) as (keyof WorkflowInput)[])
          if (merged[key] === undefined || merged[key] === "" || (merged[key] === false && key !== "default"))
            delete merged[key];
        return merged;
      }),
    );

  return (
    <div className="field">
      <span>Inputs</span>
      {inputs.length === 0 && <small>None. A run gets any JSON object as its input.</small>}
      {inputs.map((input, index) => (
        <div key={index} className="wf-input">
          <div className="wf-input-head">
            <input
              className="input mono"
              aria-label="Input name"
              placeholder="user"
              value={input.name}
              onChange={(e) => change(index, { name: e.target.value.trim() })}
            />
            <select
              className="input"
              aria-label="Input type"
              value={input.type}
              onChange={(e) => change(index, { type: e.target.value as WorkflowInput["type"] })}
            >
              {INPUT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove the input ${input.name}`}
              title="Remove"
              onClick={() => onChange(inputs.filter((_, i) => i !== index))}
            >
              ×
            </button>
          </div>
          {input.type === "entity" && (
            <select
              className="input mono"
              aria-label="Entity type"
              value={input.entity ?? ""}
              onChange={(e) => change(index, { entity: e.target.value })}
            >
              <option value="">Any entity type</option>
              {[...new Set([...entityTypes, input.entity ?? ""].filter(Boolean))].sort().map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          <input
            className="input"
            aria-label="Label"
            placeholder="Label, as the run form shows it"
            value={input.label ?? ""}
            onChange={(e) => change(index, { label: e.target.value })}
          />
          <input
            className="input"
            aria-label="Description"
            placeholder="Description"
            value={input.description ?? ""}
            onChange={(e) => change(index, { description: e.target.value })}
          />
          <div className="wf-field-row">
            <label className="wf-check inline">
              <input
                type="checkbox"
                checked={input.required === true}
                onChange={(e) => change(index, { required: e.target.checked })}
              />
              <span>Required</span>
            </label>
            {SIMPLE.has(input.type) &&
              (input.type === "boolean" ? (
                <select
                  className="input"
                  aria-label="Default"
                  value={input.default === undefined ? "" : String(input.default)}
                  onChange={(e) =>
                    change(index, { default: e.target.value === "" ? undefined : e.target.value === "true" })
                  }
                >
                  <option value="">No default</option>
                  <option value="true">Default: true</option>
                  <option value="false">Default: false</option>
                </select>
              ) : (
                <input
                  className="input"
                  aria-label="Default"
                  type={input.type === "number" ? "number" : "text"}
                  placeholder="Default"
                  value={input.default === undefined ? "" : String(input.default)}
                  onChange={(e) =>
                    change(index, {
                      default:
                        e.target.value === ""
                          ? undefined
                          : input.type === "number"
                            ? Number(e.target.value)
                            : e.target.value,
                    })
                  }
                />
              ))}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="btn ghost wf-add-input"
        onClick={() => onChange([...inputs, { name: freshName(inputs), type: "text" }])}
      >
        + Add an input
      </button>
      <small>
        Steps read each input as <span className="mono">trigger.name</span>. A run without a required input is refused.
      </small>
    </div>
  );
}
