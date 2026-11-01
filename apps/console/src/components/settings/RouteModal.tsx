import { FormEvent, useState } from "react";
import type { ClientRoute, FieldKind, FieldSource, Outcome, RouteMode } from "../../types/interfaces";
import { Modal } from "../ui/Modal";
import { Switch } from "../ui/Switch";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const MODES: { id: RouteMode; title: string; note: string }[] = [
  {
    id: "track",
    title: "Track",
    note: "Send an event after the response. Adds no time to the request.",
  },
  {
    id: "decide_request",
    title: "Decide on request",
    note: "Ask for a decision before the request reaches your app. For transfers, withdrawals and payments.",
  },
  {
    id: "decide_response",
    title: "Decide on response",
    note: "Ask for a decision after your app answers, when the user is known. For logins. Edge only: the middleware skips it.",
  },
];

const SOURCES: { id: FieldSource | "value"; title: string; hint: string }[] = [
  { id: "request.body", title: "Request body", hint: "$.amount" },
  { id: "request.query", title: "Query", hint: "currency" },
  { id: "request.header", title: "Request header", hint: "x-account" },
  { id: "request.cookie", title: "Cookie", hint: "account_id" },
  { id: "request.param", title: "Route parameter", hint: "id" },
  { id: "response.header", title: "Response header", hint: "x-kairos-user" },
  { id: "response.body", title: "Response body", hint: "$.user.id" },
  { id: "value", title: "A constant", hint: "password" },
];

const KINDS: { id: FieldKind; title: string }[] = [
  { id: "email", title: "Email" },
  { id: "phone", title: "Phone" },
  { id: "address", title: "Address" },
  { id: "username", title: "Username" },
  { id: "hmac", title: "Hashed" },
  { id: "token", title: "Token" },
];

const OUTCOMES: { id: Outcome; title: string }[] = [
  { id: "approve", title: "Approve" },
  { id: "step_up", title: "Step up" },
  { id: "review", title: "Review" },
  { id: "block", title: "Block" },
];

interface FieldRow {
  name: string;
  source: FieldSource | "value";
  path: string;
  kind: FieldKind | "";
}

const rowsOf = (route?: ClientRoute): FieldRow[] =>
  Object.entries(route?.fields ?? {}).map(([name, f]) =>
    f.value !== undefined
      ? { name, source: "value", path: String(f.value), kind: "" }
      : { name, source: f.from!, path: f.path ?? "", kind: f.kind ?? "" },
  );

export function RouteModal({
  route,
  onClose,
  onSave,
}: {
  route?: ClientRoute;
  onClose: () => void;
  onSave: (route: ClientRoute) => void;
}) {
  const [method, ...rest] = (route?.route ?? "POST /").split(" ");
  const [verb, setVerb] = useState(method!);
  const [path, setPath] = useState(rest.join(" "));
  const [mode, setMode] = useState<RouteMode>(route?.mode ?? "track");
  const [type, setType] = useState(route?.type ?? "");
  const [failed, setFailed] = useState(route?.failed ?? "");
  const [fields, setFields] = useState<FieldRow[]>(rowsOf(route));
  const [fallback, setFallback] = useState<Outcome | "">(route?.fallback ?? "");
  const [timeout, setTimeoutMs] = useState(route?.timeoutMs ? String(route.timeoutMs) : "");
  const [enforce, setEnforce] = useState(route?.enforce ?? false);
  const [blockStatus, setBlockStatus] = useState(String(route?.block?.status ?? 403));
  const [blockBody, setBlockBody] = useState(
    route?.block?.body === undefined ? "" : JSON.stringify(route.block.body, null, 2),
  );
  const [stepUp, setStepUp] = useState(route?.stepUp && route.stepUp !== "forward" ? route.stepUp.redirect : "");
  const [error, setError] = useState<string | null>(null);
  const decides = mode !== "track";

  const setField = (i: number, patch: Partial<FieldRow>) =>
    setFields(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    let body: unknown;
    if (decides && blockBody.trim()) {
      try {
        body = JSON.parse(blockBody);
      } catch {
        return setError("The block response body is not valid JSON.");
      }
    }
    const named = fields.filter((f) => f.name.trim());
    onSave({
      route: `${verb} ${path.trim()}`,
      mode,
      type: type.trim(),
      ...(failed.trim() ? { failed: failed.trim() } : {}),
      fields: Object.fromEntries(
        named.map((f) => [
          f.name.trim(),
          f.source === "value"
            ? { value: f.path }
            : { from: f.source, path: f.path.trim(), ...(f.kind ? { kind: f.kind } : {}) },
        ]),
      ),
      enforce: decides && enforce,
      ...(decides
        ? {
            fallback: (fallback || (mode === "decide_response" ? "approve" : "review")) as Outcome,
            ...(timeout ? { timeoutMs: Number(timeout) } : {}),
            block: { status: Number(blockStatus), ...(body === undefined ? {} : { body }) },
            stepUp: stepUp.trim() ? { redirect: stepUp.trim() } : "forward",
          }
        : {}),
    });
  };

  return (
    <Modal title={route ? "Edit route" : "Add route"} onClose={onClose} wide>
      <form className="modal-body" onSubmit={submit}>
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <label className="field">
          <span>Route</span>
          <div className="row">
            <select className="input" style={{ width: "auto" }} value={verb} onChange={(e) => setVerb(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <input
              className="input mono grow"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/api/payees/:id"
              required
              autoFocus
            />
          </div>
          <small>The path as your app registers it, with :name for a parameter.</small>
        </label>

        <div className="field">
          <span>What happens</span>
          <div className="key-kinds modes">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`template ${mode === m.id ? "on" : ""}`}
                onClick={() => setMode(m.id)}
              >
                <b>{m.title}</b>
                <span>{m.note}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="row wrap" style={{ alignItems: "start" }}>
          <label className="field grow">
            <span>Event type</span>
            <input
              className="input mono"
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder={mode === "decide_response" ? "login" : "beneficiary_added"}
              maxLength={128}
              required
            />
            <small>
              {decides ? "An action must start from this event type." : "Sent when the response is below 400."}
            </small>
          </label>
          <label className="field grow">
            <span>Event type when refused (optional)</span>
            <input
              className="input mono"
              value={failed}
              onChange={(e) => setFailed(e.target.value)}
              placeholder={mode === "decide_response" ? "login_failed" : "beneficiary_add_failed"}
              maxLength={128}
            />
            <small>Sent for a 4xx response. A 5xx sends nothing.</small>
          </label>
        </div>

        <div className="field">
          <span>Fields</span>
          <small>
            What the event holds. Nothing else from the request is sent. A name that ends in Id names an entity, such as
            beneficiaryId.
          </small>
          <div className="stack" style={{ gap: 8 }}>
            {fields.map((f, i) => (
              <div className="field-map" key={i}>
                <input
                  className="input mono"
                  placeholder="beneficiaryId"
                  value={f.name}
                  onChange={(e) => setField(i, { name: e.target.value })}
                  aria-label="Field name"
                />
                <select
                  className="input"
                  value={f.source}
                  onChange={(e) => setField(i, { source: e.target.value as FieldRow["source"] })}
                  aria-label="Read from"
                >
                  {SOURCES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
                <input
                  className="input mono"
                  placeholder={SOURCES.find((s) => s.id === f.source)!.hint}
                  value={f.path}
                  onChange={(e) => setField(i, { path: e.target.value })}
                  aria-label={f.source === "value" ? "Value" : "Path"}
                />
                <select
                  className="input"
                  value={f.kind}
                  disabled={f.source === "value"}
                  onChange={(e) => setField(i, { kind: e.target.value as FieldRow["kind"] })}
                  aria-label="Kind"
                >
                  <option value="">As it is</option>
                  {KINDS.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Remove field"
                  onClick={() => setFields(fields.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setFields([...fields, { name: "", source: "request.body", path: "", kind: "" }])}
              >
                + Add field
              </button>
            </div>
          </div>
        </div>

        {decides && (
          <>
            <div className="row wrap" style={{ alignItems: "start" }}>
              <label className="field grow">
                <span>If Kairos does not answer in time</span>
                <select
                  className="input"
                  value={fallback || (mode === "decide_response" ? "approve" : "review")}
                  onChange={(e) => setFallback(e.target.value as Outcome)}
                >
                  {OUTCOMES.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.title}
                    </option>
                  ))}
                </select>
                <small>Approve lets the request through. Use it for logins.</small>
              </label>
              <label className="field grow">
                <span>Time limit (ms)</span>
                <input
                  className="input"
                  type="number"
                  min={100}
                  max={10000}
                  step={100}
                  value={timeout}
                  onChange={(e) => setTimeoutMs(e.target.value)}
                  placeholder="1500"
                />
              </label>
            </div>
            <div className="row wrap" style={{ alignItems: "start" }}>
              <label className="field">
                <span>Block status</span>
                <input
                  className="input"
                  type="number"
                  min={400}
                  max={599}
                  value={blockStatus}
                  onChange={(e) => setBlockStatus(e.target.value)}
                  style={{ width: 110 }}
                  required
                />
              </label>
              <label className="field grow">
                <span>Block response body (optional)</span>
                <textarea
                  className="input mono"
                  rows={2}
                  value={blockBody}
                  onChange={(e) => setBlockBody(e.target.value)}
                  placeholder={'{ "error": "blocked" }'}
                />
              </label>
            </div>
            <label className="field">
              <span>Step up (optional)</span>
              <input
                className="input mono"
                value={stepUp}
                onChange={(e) => setStepUp(e.target.value)}
                placeholder="/verify"
              />
              <small>
                A page to send the person to. Leave it empty to pass the request to your app with the decision in the
                x-kairos-decision header.
              </small>
            </label>
            <div className="set-row" style={{ borderTop: 0, padding: 0 }}>
              <div>
                <b>Enforce</b>
                <small>
                  Off, the route monitors: Kairos decides and logs, but the request and the response do not change. On,
                  it can block, redirect or step up, when the route mode is Active.
                </small>
              </div>
              <Switch checked={enforce} onChange={setEnforce} title="Enforce" />
            </div>
          </>
        )}

        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">{route ? "Done" : "Add route"}</button>
        </div>
      </form>
    </Modal>
  );
}
