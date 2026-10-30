import type { UploadedModel } from "../../types/interfaces";
import { href } from "../../lib/route";

type Features = Record<string, unknown>;

const textOf = (value: unknown) => (value === undefined || value === null ? "" : String(value));

export function FeaturesEditor({
  stepId,
  value,
  model,
  fields,
  onChange,
}: {
  stepId: string;
  value: unknown;
  model: UploadedModel | undefined;
  fields: string[];
  onChange: (features: Features) => void;
}) {
  const features = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Features;
  if (!model) return <small className="note">Choose a model first. Its features show here.</small>;
  const names = model.definition.features.map((f) => f.name);
  const suggested = model.definition.suggested_features ?? {};
  const extra = Object.keys(features).filter((name) => !names.includes(name));
  const empty = names.filter((name) => textOf(features[name]).trim() === "");
  const canFill = names.some((name) => suggested[name] !== undefined && textOf(features[name]) !== suggested[name]);
  const list = `wf-features-${stepId}`;

  const put = (name: string, text: string) => {
    const next = { ...features };
    if (text.trim() === "") delete next[name];
    else next[name] = text;
    onChange(next);
  };
  const drop = (name: string) => {
    const { [name]: _, ...rest } = features;
    onChange(rest);
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      <datalist id={list}>
        {fields.map((f) => (
          <option key={f} value={`{{ ${f} }}`} />
        ))}
      </datalist>
      {names.map((name) => (
        <label key={name} className="field" style={{ margin: 0 }}>
          <span className="mono">{name}</span>
          <input
            className={`input mono ${empty.includes(name) ? "bad" : ""}`}
            list={list}
            placeholder={suggested[name] ?? "{{ steps.ask.output.question_1.probability }}"}
            value={textOf(features[name])}
            onChange={(e) => put(name, e.target.value)}
          />
        </label>
      ))}
      {extra.map((name) => (
        <div key={name} className="row" style={{ justifyContent: "space-between" }}>
          <small className="wh-failed">
            <span className="mono">{name}</span> is not a feature of {model.slug}.
          </small>
          <button type="button" className="btn ghost" onClick={() => drop(name)}>
            Remove
          </button>
        </div>
      ))}
      {empty.length > 0 && (
        <small className="note">
          A feature with no value cannot be saved. A value that a run cannot read, such as a step that did not run, is
          missing for that run only.
        </small>
      )}
      <div className="row wrap" style={{ justifyContent: "space-between" }}>
        {canFill && (
          <button
            type="button"
            className="btn"
            onClick={() =>
              onChange({
                ...features,
                ...Object.fromEntries(names.filter((n) => suggested[n] !== undefined).map((n) => [n, suggested[n]])),
              })
            }
          >
            Use the values from training
          </button>
        )}
        <a href={href("settings", "models", model.slug)}>About {model.name} →</a>
      </div>
    </div>
  );
}
