import { api } from "../../api/index";
import type { TotalDefinition } from "../../types/interfaces";
import { useApi } from "../../hooks/useApi";
import { cleanTotal, totalSentence, USUAL, windowDays, WINDOWS, withCurrent } from "../../lib/actions";

export function TotalForm({
  total,
  eventTypes,
  onChange,
  onRemove,
}: {
  total: TotalDefinition;
  eventTypes: string[];
  onChange: (next: TotalDefinition) => void;
  onRemove: () => void;
}) {
  const { data: options } = useApi(["metric-options", total.event], () => api.metricOptions(total.event), {
    enabled: !!total.event,
  });
  const properties = options?.event_properties ?? [];
  const numeric = properties.filter((p) => p.numeric).map((p) => p.name);
  const names = ["status", ...properties.map((p) => p.name)];
  const set = (patch: Partial<TotalDefinition>) => onChange({ ...total, ...patch });
  const conditions = Object.entries(total.where ?? {});
  const setCondition = (index: number, key: string, value: string) =>
    set({
      where: Object.fromEntries(
        conditions.map(([k, v], i) =>
          i === index ? [key, value.includes(",") ? value.split(",").map((part) => part.trim()) : value] : [k, v],
        ),
      ),
    });
  const window = windowDays(total.window);
  const usual = USUAL.filter(([, , length]) => window > 0 && length >= window * 2);
  const option = ([id, text]: [string, string]) => (
    <option key={id} value={id}>
      {text}
    </option>
  );

  return (
    <div className="total-form">
      <div className="pair-fields">
        <label className="field">
          <span>Add up</span>
          <select className="input mono" value={total.sum} onChange={(e) => set({ sum: e.target.value })}>
            <option value="">{total.event ? "Choose a number" : "Choose an event first"}</option>
            {withCurrent(
              numeric.map((n) => [n, n]),
              total.sum,
            ).map(option)}
          </select>
        </label>
        <label className="field">
          <span>From the events</span>
          <select
            className="input mono"
            value={total.event}
            onChange={(e) => set({ event: e.target.value, sum: "", where: undefined, by: undefined })}
          >
            <option value="">Choose an event</option>
            {withCurrent(
              eventTypes.map((t) => [t, t]),
              total.event,
            ).map(option)}
          </select>
        </label>
        <label className="field">
          <span>Period</span>
          <select
            className="input"
            value={total.window ?? ""}
            onChange={(e) =>
              set({
                window: e.target.value || undefined,
                ...(e.target.value && e.target.value !== "session" ? {} : { usual: undefined }),
              })
            }
          >
            {withCurrent(WINDOWS, total.window).map(option)}
            <option value="">All history</option>
          </select>
        </label>
        <label className="field">
          <span>Name</span>
          <input
            className="input mono"
            placeholder="money_in"
            value={total.name}
            onChange={(e) => set({ name: e.target.value.replace(/[^A-Za-z0-9_]/g, "_") })}
          />
          <small>The model reads it. Say what it is.</small>
        </label>
      </div>

      <div className="field">
        <span>Only events where</span>
        {conditions.map(([key, value], i) => (
          <div className="condition" key={i}>
            <select
              className="input mono"
              value={key}
              onChange={(e) => setCondition(i, e.target.value, [value].flat().join(", "))}
            >
              {withCurrent(
                names.map((n) => [n, n]),
                key,
              ).map(option)}
            </select>
            <span className="muted">is</span>
            <input
              className="input mono"
              placeholder="completed"
              value={[value].flat().join(", ")}
              onChange={(e) => setCondition(i, key, e.target.value)}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label="Remove this condition"
              onClick={() => set({ where: Object.fromEntries(conditions.filter((_, j) => j !== i)) })}
            >
              ×
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className="btn ghost"
            disabled={!total.event}
            onClick={() =>
              set({
                where: {
                  ...total.where,
                  [names.find((n) => !(n in (total.where ?? {}))) ?? `property_${conditions.length + 1}`]: "",
                },
              })
            }
          >
            + Condition
          </button>
        </div>
        {conditions.length > 0 && <small>For several values, separate them with commas: completed, pending.</small>}
      </div>

      <div className="pair-fields">
        <label className="field">
          <span>Compare with what is usual</span>
          <select
            className="input"
            value={total.usual ?? ""}
            disabled={!total.window || !!total.by}
            onChange={(e) => set({ usual: e.target.value || undefined })}
          >
            <option value="">No comparison</option>
            {withCurrent(
              usual.map(([id, text]) => [id, `Over ${text}`] as [string, string]),
              total.usual,
            ).map(option)}
          </select>
          <small>
            {total.window ? "The model is told how many times the usual amount this is." : "Needs a period."}
          </small>
        </label>
        <label className="field">
          <span>Compare with the request</span>
          <input
            className="input mono"
            list="request-amounts"
            placeholder="none"
            value={total.covers ?? ""}
            disabled={!!total.by}
            onChange={(e) => set({ covers: e.target.value || undefined })}
          />
          <datalist id="request-amounts">
            {[...new Set(["amount", "usd", ...numeric])].map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <small>A number in the request, such as amount. The model is told what share of it the total covers.</small>
        </label>
        <label className="field">
          <span>Split by</span>
          <select
            className="input mono"
            value={total.by ?? ""}
            onChange={(e) =>
              set({
                by: e.target.value || undefined,
                ...(e.target.value ? { usual: undefined, covers: undefined } : {}),
              })
            }
          >
            <option value="">No split</option>
            {withCurrent(
              properties.filter((p) => !p.numeric).map((p) => [p.name, p.name] as [string, string]),
              total.by,
            ).map(option)}
          </select>
          <small>For example currency. Not with a comparison.</small>
        </label>
      </div>

      <div className="total-foot">
        <span className="note">
          {total.name && total.event && total.sum
            ? totalSentence(cleanTotal(total))
            : "Choose an event and a number to add up."}
        </span>
        <button type="button" className="btn ghost" onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}
