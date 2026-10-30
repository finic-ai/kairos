import { api } from "../../api/index";
import { useApi } from "../../hooks/useApi";

/**
 * The switch for automatic decisions, with what it costs: the decisions a day it would have made
 * over the last 7 days of matching events. An event from a public key never starts one.
 */
export function AutomaticField({
  name,
  trigger,
  on,
  onChange,
}: {
  name?: string;
  trigger: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const { data } = useApi(["automatic-estimate", name, trigger], () => api.automaticEstimate(name!).catch(() => null), {
    enabled: !!name,
  });
  return (
    <div className="field">
      <label className={`check auto-check ${on ? "on" : ""}`}>
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} disabled={!trigger.trim()} />
        Decide automatically on tracked events
      </label>
      <small>
        Each <span className="mono">{trigger.trim() || "event"}</span> event that your server sends with{" "}
        <span className="mono">track()</span>, or that an inbound webhook brings, is decided in the background, with
        nobody waiting. The decision goes out to your webhooks. Events from a public key, and events more than an hour
        old, are never decided.
      </small>
      {on && (
        <small className="auto-estimate">
          {data?.available === false
            ? "This server does not run automatic decisions."
            : data
              ? `About ${data.per_day.toLocaleString()} ${data.per_day === 1 ? "decision" : "decisions"} a day, from the last 7 days of matching events. Each is one call to the model.`
              : name
                ? "Counting the matching events of the last 7 days…"
                : "Each matching event is one call to the model."}
        </small>
      )}
    </div>
  );
}
