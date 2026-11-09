import {
  applyMapping,
  validateMapping,
  EntityValue,
  MappingEvent,
  MappingLabel,
  MappingRule,
  MappingValue,
  WebhookMapping,
} from "@kairos/core";
import { useEffect, useMemo, useRef, useState, FormEvent, ReactNode } from "react";
import { webhooks } from "../../../api/index";
import type {
  Backfill,
  ShopifyConnection,
  Verification,
  Webhook,
  WebhookDelivery,
  WebhookPreset,
  Workspace,
} from "../../../types/interfaces";
import { Tabs } from "./Webhooks";
import { Choice } from "../../../components/ui/Choice";
import { Copy } from "../../../components/ui/Copy";
import { Group, Row } from "../../../components/ui/Group";
import { Modal } from "../../../components/ui/Modal";
import { Tab, TabStrip } from "../../../components/ui/TabStrip";
import { Empty, Loading } from "../../../components/ui/states";
import { dayOf, stamp } from "../../../lib/format";
import { go, href } from "../../../lib/route";
import { useApi, useWebhookPresets } from "../../../hooks/useApi";

/**
 * The preview runs the same engine as the server (@kairos/core), so it cannot differ.
 */

const SCHEME_TEXT: Record<Verification["scheme"], string> = {
  hmac: "HMAC signature of the body, in a header",
  timestamped: "HMAC of a time and the body (Persona, Zendesk)",
  standard: "Standard Webhooks (Svix, Lithic, Sardine)",
  stripe: "Stripe signature (Stripe-Signature header)",
  header: "A fixed secret value in a header",
  none: "None: the URL token only",
};

/** For a template card, where the full text does not fit. */
const SCHEME_SHORT: Record<Verification["scheme"], string> = {
  hmac: "HMAC",
  timestamped: "Timestamped HMAC",
  standard: "Standard Webhooks",
  stripe: "Stripe signature",
  header: "Header token",
  none: "No signature",
};

interface Sample {
  body: unknown;
  headers?: Record<string, string>;
}

const headersText = (headers?: Record<string, string>) =>
  headers && Object.keys(headers).length ? JSON.stringify(headers, null, 2) : "";

function sampleLabel(provider: string, index: number, sample: unknown, headers?: Record<string, string>) {
  const body = (sample ?? {}) as Record<string, unknown>;
  const topic = Object.entries(headers ?? {}).find(([k]) => k.toLowerCase().endsWith("-topic"))?.[1];
  const kind = [topic, body.type, body.event_type, body.topic].find((v) => typeof v === "string");
  return `${provider} sample ${index + 1}${kind ? `: ${kind}` : ""}`;
}

const CATEGORIES: [WebhookPreset["category"], string][] = [
  ["device_intelligence", "Device Intelligence"],
  ["identity_verification", "Identity"],
  ["payments", "Payments"],
  ["commerce", "Commerce"],
  ["customer_support", "Customer Support"],
  ["transaction_intelligence", "Transaction Intelligence"],
];

const CATEGORY_ICONS: Record<WebhookPreset["category"], ReactNode> = {
  device_intelligence: (
    <>
      <rect x="6" y="2.5" width="8" height="15" rx="1.6" />
      <path d="M9 14.5h2" />
    </>
  ),
  identity_verification: (
    <>
      <rect x="2.5" y="4.5" width="15" height="11" rx="1.8" />
      <circle cx="7" cy="9" r="1.6" />
      <path d="M4.8 12.8c.5-1 1.3-1.5 2.2-1.5s1.7.5 2.2 1.5M11.5 8.5h3.5M11.5 11.5h2.5" />
    </>
  ),
  payments: (
    <>
      <rect x="2.5" y="4.5" width="15" height="11" rx="1.8" />
      <path d="M2.5 8.5h15M5.5 12.5h3" />
    </>
  ),
  commerce: <path d="M4.5 7h11l-1 10h-9zM7.5 7V5.5a2.5 2.5 0 0 1 5 0V7" />,
  customer_support: <path d="M3.5 4.5h13v9h-7l-4 3v-3h-2z" />,
  transaction_intelligence: <path d="M4 7h12l-3-3M16 13H4l3 3" />,
};

/** The schemes that prove the sender with a signature over the body: a mapping may set entity properties. */
const SIGNS = new Set<Verification["scheme"]>(["hmac", "timestamped", "stripe", "standard"]);

const SOURCE_STATUSES = [
  ["", "All"],
  ["stored", "Stored"],
  ["failed", "Failed"],
  ["no_entity", "No entity"],
  ["ignored", "Ignored"],
  ["duplicate", "Duplicate"],
  ["rejected", "Rejected"],
] as const;
const TONE: Record<string, string> = {
  stored: "ok",
  duplicate: "",
  ignored: "",
  failed: "warn",
  no_entity: "review",
  rejected: "warn",
};
const LABEL: Record<string, string> = {
  stored: "Stored",
  duplicate: "Duplicate",
  ignored: "Ignored",
  failed: "Failed",
  no_entity: "No entity",
  rejected: "Rejected",
};

const STARTER: WebhookMapping = {
  rules: [{ name: "Event", event: { id: "$.id", type: "$.type", entities: { user: "$.user_id" } } }],
};

const fullUrl = (path: string) => `${window.location.origin}${path}`;

export function SourceList({ workspace }: { workspace: Workspace }) {
  const {
    data,
    error,
    refetch: reload,
  } = useApi(["webhook-sources", workspace.id], () => webhooks.sources(workspace.id), {
    refetchInterval: 15_000,
  });
  const { data: presets } = useWebhookPresets();
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<{ webhook: Webhook; path: string } | null>(null);
  const providerOf = (w: Webhook) =>
    presets?.presets.find((p) => w.preset?.startsWith(`${p.provider}@`))?.displayName ?? "Custom";

  return (
    <>
      <Tabs on="inbound" />
      {error && <div className="banner">{error.message}</div>}
      <Group
        title="Sources"
        note="A provider, such as a payment processor or an identity provider, sends its events to a URL that Kairos provides."
        action={
          <button className="btn primary" onClick={() => setAdding(true)} disabled={!data}>
            Add source
          </button>
        }
      >
        <div className="card table-wrap">
          {!data ? (
            <Loading />
          ) : data.webhooks.length === 0 ? (
            <Empty title="No sources yet">
              Add a source to receive a provider's webhooks. Stripe is ready to use; any other provider works with a
              mapping you describe.
            </Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="hide-md">Verification</th>
                  <th>Status</th>
                  <th className="hide-md">Last delivery</th>
                  <th className="hide-md" style={{ textAlign: "right" }}>
                    Last 24 hours
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.webhooks.map((w) => (
                  <tr key={w.id} className="link" onClick={() => go("settings", "webhooks", w.id)}>
                    <td>
                      <b>{w.name}</b>
                      <div className="muted">{providerOf(w)}</div>
                    </td>
                    <td className="hide-md">
                      {w.verification ? SCHEME_TEXT[w.verification.scheme].split(" (")[0] : "—"}
                    </td>
                    <td>
                      <span className={`chip ${w.enabled ? "ok" : "warn"}`}>{w.enabled ? "Active" : "Disabled"}</span>
                    </td>
                    <td className="hide-md mono muted">{w.last_delivery ? stamp(w.last_delivery) : "Never"}</td>
                    <td className="hide-md mono" style={{ textAlign: "right" }}>
                      {w.deliveries_24h ?? 0}
                      {(w.failures_24h ?? 0) > 0 && <div className="wh-failed">{w.failures_24h} not stored</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Group>
      {adding && presets && (
        <NewSource
          workspace={workspace}
          presets={presets.presets}
          onClose={() => setAdding(false)}
          onCreated={(made) => (setAdding(false), setCreated(made), reload())}
        />
      )}
      {created && (
        <UrlShown
          title="Source added"
          name={created.webhook.name}
          path={created.path}
          onDone={() => go("settings", "webhooks", created.webhook.id)}
        />
      )}
    </>
  );
}

/** The URL of a source, shown once: only its hash is kept. */
function UrlShown({ title, name, path, onDone }: { title: string; name: string; path: string; onDone: () => void }) {
  return (
    <Modal title={title} onClose={onDone}>
      <div className="modal-body">
        <p>
          Give this URL to the provider as the webhook endpoint of <b>{name}</b>. It contains a secret token: store it
          with your other secrets. You won't see it again; you can make a new one later.
        </p>
        <Copy value={fullUrl(path)} />
        <p className="note">
          The address is this server's. If the provider must reach it at another address (a public domain in front of
          it), use that address with the same path.
        </p>
        <div className="modal-foot">
          <button className="btn primary" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

function VerificationFields({ value, onChange }: { value: Verification; onChange: (v: Verification) => void }) {
  const fresh = (scheme: Verification["scheme"]): Verification =>
    scheme === "hmac"
      ? { scheme, header: "X-Signature", algorithm: "sha256", encoding: "hex" }
      : scheme === "timestamped"
        ? { scheme, header: "X-Signature" }
        : scheme === "header"
          ? { scheme, header: "X-Webhook-Token" }
          : { scheme };
  return (
    <>
      <label className="field">
        <span>Verification</span>
        <select
          className="input"
          value={value.scheme}
          onChange={(e) => onChange(fresh(e.target.value as Verification["scheme"]))}
        >
          {(Object.keys(SCHEME_TEXT) as Verification["scheme"][]).map((s) => (
            <option key={s} value={s}>
              {SCHEME_TEXT[s]}
            </option>
          ))}
        </select>
      </label>
      {(value.scheme === "hmac" || value.scheme === "header" || value.scheme === "timestamped") && (
        <label className="field">
          <span>{value.scheme === "timestamped" ? "Signature header" : "Header"}</span>
          <input
            className="input mono"
            value={value.header}
            onChange={(e) => onChange({ ...value, header: e.target.value })}
            placeholder="X-Signature"
            required
          />
        </label>
      )}
      {value.scheme === "timestamped" && (
        <>
          <label className="field">
            <span>Where the time is</span>
            <select
              className="input"
              value={value.timestampHeader === undefined ? "inside" : "own"}
              onChange={(e) =>
                onChange(
                  e.target.value === "own"
                    ? { ...value, timestampHeader: "X-Timestamp", timestampKey: undefined, signatureKey: undefined }
                    : { ...value, timestampHeader: undefined },
                )
              }
            >
              <option value="inside">In the signature header: t=…,v1=…</option>
              <option value="own">In a header of its own</option>
            </select>
          </label>
          <div className="pair-fields">
            {value.timestampHeader !== undefined ? (
              <label className="field">
                <span>Time header</span>
                <input
                  className="input mono"
                  value={value.timestampHeader}
                  onChange={(e) => onChange({ ...value, timestampHeader: e.target.value })}
                  placeholder="X-Timestamp"
                  required
                />
              </label>
            ) : (
              <>
                <label className="field">
                  <span>Time key</span>
                  <input
                    className="input mono"
                    value={value.timestampKey ?? ""}
                    onChange={(e) => onChange({ ...value, timestampKey: e.target.value || undefined })}
                    placeholder="t"
                  />
                </label>
                <label className="field">
                  <span>Signature key</span>
                  <input
                    className="input mono"
                    value={value.signatureKey ?? ""}
                    onChange={(e) => onChange({ ...value, signatureKey: e.target.value || undefined })}
                    placeholder="v1"
                  />
                </label>
              </>
            )}
            <label className="field">
              <span>Between time and body</span>
              <input
                className="input mono"
                value={value.join ?? "."}
                onChange={(e) => onChange({ ...value, join: e.target.value === "." ? undefined : e.target.value })}
                placeholder="(nothing)"
              />
            </label>
          </div>
        </>
      )}
      {(value.scheme === "hmac" || value.scheme === "timestamped") && (
        <div className="pair-fields">
          <label className="field">
            <span>Algorithm</span>
            <select
              className="input"
              value={value.algorithm ?? "sha256"}
              onChange={(e) => onChange({ ...value, algorithm: e.target.value as "sha256" })}
            >
              <option>sha256</option>
              <option>sha1</option>
              <option>sha512</option>
            </select>
          </label>
          <label className="field">
            <span>Encoding</span>
            <select
              className="input"
              value={value.encoding ?? "hex"}
              onChange={(e) => onChange({ ...value, encoding: e.target.value as "hex" })}
            >
              <option>hex</option>
              <option>base64</option>
            </select>
          </label>
          {value.scheme === "hmac" && (
            <label className="field">
              <span>Prefix (optional)</span>
              <input
                className="input mono"
                value={value.prefix ?? ""}
                onChange={(e) => onChange({ ...value, prefix: e.target.value || undefined })}
                placeholder="sha256="
              />
            </label>
          )}
        </div>
      )}
      {value.scheme === "standard" && (
        <small className="muted">
          The webhook-id, webhook-timestamp and webhook-signature headers (or their svix- names), with a whsec_… secret.
        </small>
      )}
      {value.scheme === "none" && (
        <div className="banner" style={{ margin: 0 }}>
          Anyone who has the URL can send events. Use this only for a provider that cannot sign, and never to set entity
          properties.
        </div>
      )}
    </>
  );
}

/** Provider → the URL of its logo, from a file in assets/providers named for the provider. */
const LOGOS: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../../assets/providers/*.{svg,png}", { eager: true, import: "default" }),
  ).map(([file, url]) => [
    file
      .split("/")
      .pop()!
      .replace(/\.\w+$/, ""),
    url,
  ]),
);

function ProviderMark({ preset }: { preset: WebhookPreset }) {
  const logo = LOGOS[preset.provider];
  return (
    <span className={`choice-mark${logo ? " logo" : ""}`} aria-hidden="true">
      {logo ? <img src={logo} alt="" /> : preset.displayName.slice(0, 1)}
    </span>
  );
}

const categoryTitle = (category: WebhookPreset["category"]) =>
  CATEGORIES.find(([c]) => c === category)?.[1] ?? category;

function TemplateCard({
  preset,
  showCategory,
  onClick,
}: {
  preset: WebhookPreset;
  showCategory: boolean;
  onClick: () => void;
}) {
  const rules = preset.mapping.rules.length;
  const events = preset.events.length;
  return (
    <button type="button" className="template-card" onClick={onClick}>
      <span className="template-card-head">
        <ProviderMark preset={preset} />
        <span className="template-card-title">
          <b>{preset.displayName}</b>
          {showCategory && (
            <small>
              <svg viewBox="0 0 20 20" aria-hidden="true">
                {CATEGORY_ICONS[preset.category]}
              </svg>
              {categoryTitle(preset.category)}
            </small>
          )}
        </span>
      </span>
      <span className="template-card-note">{preset.description}</span>
      <span className="template-card-foot">
        <small>
          {SCHEME_SHORT[preset.verification.scheme]} · {rules} {rules === 1 ? "rule" : "rules"} · {events} event{" "}
          {events === 1 ? "type" : "types"}
        </small>
      </span>
    </button>
  );
}

function TemplatePicker({
  presets,
  onChoose,
  onScratch,
}: {
  presets: WebhookPreset[];
  onChoose: (preset: WebhookPreset) => void;
  onScratch: () => void;
}) {
  const [tab, setTab] = useState<WebhookPreset["category"] | "all">("all");
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = presets.filter((p) => {
    const text = [p.displayName, p.provider, p.description, categoryTitle(p.category), ...p.events]
      .join(" ")
      .toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const inTab = (p: WebhookPreset, t: typeof tab) => t === "all" || p.category === t;
  const shown = CATEGORIES.flatMap(([c]) => found.filter((p) => p.category === c && inTab(p, tab)));
  const tabs = CATEGORIES.filter(([c]) => presets.some((p) => p.category === c));

  return (
    <div className="template-picker">
      <input
        className="input search"
        type="search"
        aria-label="Search templates"
        placeholder="Search by provider, or by what it sends: disputes, tickets, cards…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && shown.length === 1 && onChoose(shown[0]!)}
        autoFocus
      />
      <TabStrip label="Template categories" className="template-tabs">
        {[["all", "All"] as const, ...tabs].map(([t, title]) => {
          const count = found.filter((p) => inTab(p, t)).length;
          return (
            <Tab key={t} on={tab === t} onSelect={() => setTab(t)} className={count === 0 ? "none" : undefined}>
              {t !== "all" && (
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  {CATEGORY_ICONS[t]}
                </svg>
              )}
              {title}
              <span className="count">{count}</span>
            </Tab>
          );
        })}
      </TabStrip>
      {shown.length > 0 ? (
        <div className="preset-grid">
          {shown.map((p) => (
            <TemplateCard key={p.provider} preset={p} showCategory={tab === "all"} onClick={() => onChoose(p)} />
          ))}
        </div>
      ) : (
        <div className="template-empty">
          <p>
            {words.length
              ? `No template matches "${query.trim()}"${tab === "all" ? "" : ` in ${categoryTitle(tab)}`}.`
              : "No templates in this category yet."}
          </p>
          <p className="note">Any provider works with a mapping that you describe.</p>
          <button type="button" className="btn" onClick={onScratch}>
            Start from scratch
          </button>
        </div>
      )}
    </div>
  );
}

function NewSource({
  workspace,
  presets,
  onClose,
  onCreated,
}: {
  workspace: Workspace;
  presets: WebhookPreset[];
  onClose: () => void;
  onCreated: (made: { webhook: Webhook; path: string }) => void;
}) {
  const [choice, setChoice] = useState<WebhookPreset | "custom" | null>(null);
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [verification, setVerification] = useState<Verification>({
    scheme: "hmac",
    header: "X-Signature",
    algorithm: "sha256",
    encoding: "hex",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const choose = (c: WebhookPreset | "custom") => (
    setChoice(c),
    setName(c === "custom" ? "" : `${c.displayName} production`)
  );
  const scheme = choice === "custom" ? verification : choice?.verification;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!choice || !scheme) return;
    setSaving(true);
    setError(null);
    try {
      const made = await webhooks.createSource(workspace.id, {
        name: name.trim(),
        verification: scheme,
        ...(scheme.scheme !== "none" ? { secret: secret.trim() } : {}),
        mapping: choice === "custom" ? STARTER : choice.mapping,
        ...(choice !== "custom" ? { preset: `${choice.provider}@${choice.version}` } : {}),
      });
      onCreated({ webhook: made.webhook, path: made.path });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!choice && !picking)
    return (
      <Modal title="Add source" onClose={onClose}>
        <div className="modal-body">
          <p>How do you want to start?</p>
          <div className="choice-list">
            <Choice
              mark="+"
              title="Start from scratch"
              note="For any provider. You describe how its payload becomes events and labels, with a live preview on a sample."
              onClick={() => choose("custom")}
            />
            <Choice
              mark="⧉"
              title="Start from a template"
              note="For a provider Kairos knows: the verification and the mapping are ready, and you can change them later."
              meta={presets.length === 1 ? "1 template" : `${presets.length} templates`}
              onClick={() => setPicking(true)}
              disabled={presets.length === 0}
            />
          </div>
        </div>
      </Modal>
    );

  if (!choice)
    return (
      <Modal title="Choose a template" onClose={onClose} wide>
        <div className="modal-body">
          <TemplatePicker presets={presets} onChoose={choose} onScratch={() => choose("custom")} />
          <div className="modal-foot">
            <button type="button" className="btn" onClick={() => setPicking(false)}>
              Back
            </button>
          </div>
        </div>
      </Modal>
    );

  return (
    <Modal title={choice === "custom" ? "Add a custom source" : `Add ${choice.displayName}`} onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            required
            autoFocus
          />
        </label>
        {choice === "custom" ? (
          <VerificationFields value={verification} onChange={setVerification} />
        ) : (
          <div className="field">
            <span>Setup at {choice.displayName}</span>
            <ol className="setup-steps">
              {choice.setup.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <small>The URL to give {choice.displayName} is shown after you add the source.</small>
          </div>
        )}
        {scheme && scheme.scheme !== "none" && (
          <label className="field">
            <span>Signing secret</span>
            <input
              className="input mono"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={choice !== "custom" ? choice.secretHint : "The secret the provider signs with"}
              required
              autoComplete="off"
            />
            <small>Stored encrypted. Kairos uses it to check each delivery.</small>
          </label>
        )}
        {choice !== "custom" && choice.identity && <p className="note">{choice.identity}</p>}
        {choice !== "custom" && !choice.checked && (
          <p className="note">
            This template is written from {choice.displayName}'s documentation and has not yet been checked with a real
            delivery. After the first deliveries arrive, look at them in the delivery log and correct the mapping if a
            field is missing.
          </p>
        )}
        {choice === "custom" && (
          <p className="note">
            The source starts with a simple mapping. Change it on the next page, on a sample payload.
          </p>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => setChoice(null)}>
            Back
          </button>
          <button className="btn primary" disabled={saving}>
            {saving ? "Adding…" : "Add source"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function SourceDetail({
  workspace,
  webhook,
  reload,
}: {
  workspace: Workspace;
  webhook: Webhook;
  reload: () => void;
}) {
  const [status, setStatus] = useState("");
  const [limit, setLimit] = useState(50);
  const { data: log, refetch: reloadLog } = useApi(
    ["webhook-deliveries", workspace.id, webhook.id, status, limit],
    () => webhooks.deliveries(workspace.id, webhook.id, { status: status || undefined, limit }),
    { refetchInterval: 5_000 },
  );
  const { data: presets } = useWebhookPresets();
  const preset = presets?.presets.find((p) => webhook.preset === `${p.provider}@${p.version}`);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [sample, setSample] = useState<Sample | undefined>(undefined);
  const [secretMode, setSecretMode] = useState<"replace" | "add" | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const closeEditor = () => {
    if (dirty && !window.confirm("Close without saving? The changes to the mapping are lost.")) return;
    setDirty(false);
    setSample(undefined);
    setEditing(false);
  };

  const run = <T,>(work: Promise<T>, done?: string | ((r: T) => string)) =>
    work.then(
      (r) => (setError(null), setNotice(typeof done === "function" ? done(r) : (done ?? null)), reload(), reloadLog()),
      (e: Error) => setError(e.message),
    );
  const replayText = (r: { replayed: number; statuses: Record<string, number> }) =>
    r.replayed === 0
      ? "No delivery to run again."
      : `Ran ${r.replayed} again: ${Object.entries(r.statuses)
          .map(([s, n]) => `${n} ${(LABEL[s] ?? s).toLowerCase()}`)
          .join(", ")}.`;

  return (
    <>
      <a className="crumb" href={href("settings", "webhooks", "inbound")}>
        ← Inbound webhooks
      </a>
      <div className="wh-head">
        <div>
          <h1>{webhook.name}</h1>
          <div className="muted">
            {preset ? `${preset.displayName} preset` : webhook.preset ? webhook.preset : "Custom source"}
          </div>
        </div>
        <span className={`chip ${webhook.enabled ? "ok" : "warn"}`}>{webhook.enabled ? "Active" : "Disabled"}</span>
      </div>
      {error && <div className="banner">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
      {!webhook.enabled && (
        <div className="banner">
          Disabled: deliveries to its URL are refused with 404, and the provider may retry them later.
        </div>
      )}

      <Group
        title="Address and verification"
        action={
          <button
            className="btn"
            onClick={() =>
              run(
                webhooks.updateSource(workspace.id, webhook.id, { enabled: !webhook.enabled }),
                webhook.enabled ? "Source disabled." : "Source enabled.",
              )
            }
          >
            {webhook.enabled ? "Disable" : "Enable"}
          </button>
        }
      >
        <div className="card rows">
          <Row title="URL" note="Shown once when it was made. A new URL stops the old one at once.">
            <span className="mono muted">/v1/webhooks/{webhook.token_hint}</span>
            <button
              className="btn"
              onClick={() =>
                window.confirm(
                  "Make a new URL? The current one stops working at once; give the new one to the provider.",
                ) &&
                webhooks.newToken(workspace.id, webhook.id).then(
                  (r) => setUrl(r.path),
                  (e: Error) => setError(e.message),
                )
              }
            >
              New URL
            </button>
          </Row>
          <Row title="Verification">
            <span>{webhook.verification ? SCHEME_TEXT[webhook.verification.scheme] : "—"}</span>
          </Row>
          {webhook.verification && webhook.verification.scheme !== "none" && (
            <Row
              title="Signing secret"
              note={
                webhook.secret_hints.length > 1
                  ? "Two secrets: a delivery signed with either is accepted."
                  : "Rotated at the provider? Add the new one first, then replace."
              }
            >
              <div className="stack" style={{ gap: 4, alignItems: "flex-end" }}>
                {webhook.secret_hints.map((s) => (
                  <span key={s.hint + s.added} className="mono">
                    {s.hint}
                  </span>
                ))}
              </div>
              <div className="row">
                <button className="btn" onClick={() => setSecretMode("add")}>
                  Add second
                </button>
                <button className="btn" onClick={() => setSecretMode("replace")}>
                  Replace
                </button>
              </div>
            </Row>
          )}
          {preset?.identity && (
            <Row title="Your user id" note={preset.identity}>
              {null}
            </Row>
          )}
        </div>
      </Group>

      {webhook.preset?.startsWith("shopify@") && (
        <PastOrders workspace={workspace} webhook={webhook} reload={reload} onImported={reloadLog} />
      )}

      <Group
        title="Mapping"
        note="How a delivery becomes events and labels. Each rule that matches runs."
        action={
          <button className="btn" onClick={() => setEditing(true)}>
            Edit mapping
          </button>
        }
      >
        <MappingSummary mapping={webhook.mapping ?? STARTER} />
      </Group>
      {editing && (
        <Modal title={`Mapping of ${webhook.name}`} onClose={closeEditor} className="mapping-modal">
          <div className="modal-body">
            <p className="note">Try it on a sample payload: the result is what the server stores.</p>
            <MappingEditor
              initial={webhook.mapping ?? STARTER}
              allowSet={!!webhook.verification && SIGNS.has(webhook.verification.scheme)}
              samples={[
                ...(preset?.samples ?? []).map((s, i) => ({
                  label: sampleLabel(preset!.displayName, i, s, preset!.sampleHeaders?.[i]),
                  body: s,
                  headers: preset!.sampleHeaders?.[i],
                })),
              ]}
              deliveries={log?.deliveries.filter((d) => d.status !== "rejected") ?? []}
              loadDelivery={(id) =>
                webhooks
                  .delivery(workspace.id, webhook.id, id)
                  .then((d) => ({ body: d.payload, headers: d.headers ?? undefined }))
              }
              external={sample}
              onChanged={setDirty}
              onSave={(mapping) =>
                webhooks.updateSource(workspace.id, webhook.id, { mapping }).then(() => {
                  setNotice("Mapping saved. New deliveries use it; run failed ones again below.");
                  setDirty(false);
                  setEditing(false);
                  reload();
                })
              }
            />
          </div>
        </Modal>
      )}

      <Group title="Deliveries" note="Each delivery, with what it stored. The payload is kept 7 days.">
        <div className="log-toolbar">
          <TabStrip label="Delivery status">
            {SOURCE_STATUSES.map(([value, text]) => (
              <Tab key={value} on={status === value} onSelect={() => (setStatus(value), setLimit(50))}>
                {text}
              </Tab>
            ))}
          </TabStrip>
          <button
            className="btn"
            onClick={() => run(webhooks.replay(workspace.id, webhook.id, { status: "failed" }), replayText)}
          >
            Run failed again
          </button>
        </div>
        <div className="card table-wrap">
          {!log ? (
            <Loading />
          ) : log.deliveries.length === 0 ? (
            <Empty title={status ? "No deliveries with this status" : "No deliveries yet"}>
              {status ? null : "Send a test event from the provider's dashboard."}
            </Empty>
          ) : (
            <table className="wh-log">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Provider event</th>
                  <th>Status</th>
                  <th className="hide-md">What happened</th>
                </tr>
              </thead>
              <tbody>
                {log.deliveries.map((d) => (
                  <tr key={d.id} className="link" onClick={() => setOpened(d.id)}>
                    <td className="mono">{stamp(d.created)}</td>
                    <td>
                      <span className="mono">{d.type ?? "—"}</span>
                      {d.external_id && <div className="muted mono wh-id">{d.external_id}</div>}
                    </td>
                    <td>
                      <span className={`chip ${TONE[d.status] ?? ""}`}>{LABEL[d.status] ?? d.status}</span>
                      {d.attempts > 1 && <div className="muted">run {d.attempts} times</div>}
                    </td>
                    <td className="hide-md">
                      {d.problem ? <span className="wh-failed">{d.problem}</span> : <span className="muted">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {log?.next_offset && (
          <button className="btn ghost usage-more" onClick={() => setLimit(limit + 50)}>
            Show more
          </button>
        )}
      </Group>

      <Group title="Danger zone">
        <div className="card rows danger">
          <Row
            title="Delete source"
            note="Its URL stops at once, and its delivery log is deleted. The events it stored stay."
          >
            <button
              className="btn danger"
              onClick={() =>
                window.confirm(`Delete "${webhook.name}" and its delivery log?`) &&
                webhooks.remove(workspace.id, webhook.id).then(
                  () => go("settings", "webhooks", "inbound"),
                  (e: Error) => setError(e.message),
                )
              }
            >
              Delete source
            </button>
          </Row>
        </div>
      </Group>

      {url && <UrlShown title="New URL" name={webhook.name} path={url} onDone={() => (setUrl(null), reload())} />}
      {secretMode && (
        <SecretForm
          mode={secretMode}
          onClose={() => setSecretMode(null)}
          onSave={(value) =>
            webhooks
              .updateSource(workspace.id, webhook.id, secretMode === "add" ? { add_secret: value } : { secret: value })
              .then(
                () => (
                  setSecretMode(null),
                  setNotice(secretMode === "add" ? "Second secret added." : "Secret replaced."),
                  reload()
                ),
              )
          }
        />
      )}
      {opened && (
        <SourceDelivery
          workspace={workspace}
          webhook={webhook}
          id={opened}
          onClose={() => setOpened(null)}
          onSample={(s) => (setSample(s), setOpened(null), setEditing(true))}
          onReplayed={(r) => (setOpened(null), setNotice(replayText(r)), reloadLog())}
        />
      )}
    </>
  );
}

const LOOKBACK: [number, string][] = [
  [1, "1 month"],
  [3, "3 months"],
  [6, "6 months"],
  [12, "12 months"],
  [24, "24 months"],
];

function backfillText(b: Backfill): string {
  const counts = `${b.orders} ${b.orders === 1 ? "order" : "orders"} and ${b.disputes} ${b.disputes === 1 ? "dispute" : "disputes"}`;
  if (b.status === "running")
    return `Importing ${b.phase === "orders" ? "orders" : "disputes"} since ${dayOf(b.since)}: ${counts} so far.`;
  if (b.status === "paused") return `Paused while the source is disabled: ${counts} so far.`;
  if (b.status === "failed") return `Stopped after ${counts}: ${b.error ?? "an error"}`;
  const failed = b.failed ? `, ${b.failed} failed (see Failed and No entity below)` : "";
  return `Imported ${counts} since ${dayOf(b.since)}: ${b.stored} stored, ${b.duplicate} there already${failed}.`;
}

function PastOrders({
  workspace,
  webhook,
  reload,
  onImported,
}: {
  workspace: Workspace;
  webhook: Webhook;
  reload: () => void;
  onImported: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [months, setMonths] = useState(6);
  const [error, setError] = useState<string | null>(null);
  const { data, refetch } = useApi(
    ["webhook-backfill", workspace.id, webhook.id],
    () => webhooks.backfill(workspace.id, webhook.id),
    { refetchInterval: (q) => (q.state.data?.backfill?.status === "running" ? 3_000 : false) },
  );
  const backfill = data?.backfill ?? null;
  const running = backfill?.status === "running" || backfill?.status === "paused";
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) onImported();
    wasRunning.current = running;
  }, [running, onImported]);

  const start = () => {
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - months);
    webhooks.startBackfill(workspace.id, webhook.id, since.toISOString()).then(
      () => (setError(null), refetch()),
      (e: Error) => setError(e.message),
    );
  };

  return (
    <Group
      title="Past orders"
      note="Import the shop's orders, refunds and disputes from before the webhook was connected."
    >
      {error && <div className="banner">{error}</div>}
      <div className="card rows">
        <Row
          title="Shop"
          note={
            webhook.shopify
              ? "Kairos reads orders and disputes with the app's credentials. It never changes the shop."
              : "Paste the credentials of a Shopify app with read access to orders, customers and disputes."
          }
        >
          {webhook.shopify && (
            <div className="stack" style={{ gap: 4, alignItems: "flex-end" }}>
              <span className="mono">{webhook.shopify.shop}</span>
              <span className="mono muted">{webhook.shopify.client_id ?? webhook.shopify.secret_hint}</span>
            </div>
          )}
          <div className="row">
            {webhook.shopify && (
              <button
                className="btn"
                onClick={() =>
                  window.confirm("Disconnect the shop? Kairos forgets its credentials.") &&
                  webhooks
                    .updateSource(workspace.id, webhook.id, { shopify: null })
                    .then(reload, (e: Error) => setError(e.message))
                }
              >
                Disconnect
              </button>
            )}
            <button className="btn" onClick={() => setConnecting(true)}>
              {webhook.shopify ? "Change" : "Connect shop"}
            </button>
          </div>
        </Row>
        {webhook.shopify && (
          <Row
            title="Import"
            note="Orders that are there already, from the webhook or an earlier import, are not stored twice."
          >
            <div className="row">
              <select
                className="input"
                aria-label="How far back"
                value={months}
                onChange={(e) => setMonths(Number(e.target.value))}
                disabled={running}
              >
                {LOOKBACK.map(([m, text]) => (
                  <option key={m} value={m}>
                    {text}
                  </option>
                ))}
              </select>
              <button className="btn primary" onClick={start} disabled={running}>
                {running ? "Importing…" : "Import"}
              </button>
            </div>
          </Row>
        )}
        {backfill && (
          <Row title={backfill.status === "done" ? "Last import" : "Import"}>
            <span className={backfill.status === "failed" ? "wh-failed" : "muted"}>{backfillText(backfill)}</span>
          </Row>
        )}
      </div>
      {connecting && (
        <ShopifyForm
          initialShop={webhook.shopify?.shop ?? ""}
          onClose={() => setConnecting(false)}
          onSave={(connection) =>
            webhooks
              .updateSource(workspace.id, webhook.id, { shopify: connection })
              .then(() => (setConnecting(false), setError(null), reload()))
          }
        />
      )}
    </Group>
  );
}

function ShopifyForm({
  initialShop,
  onClose,
  onSave,
}: {
  initialShop: string;
  onClose: () => void;
  onSave: (connection: ShopifyConnection) => Promise<unknown>;
}) {
  const [kind, setKind] = useState<"app" | "token">("app");
  const [shop, setShop] = useState(initialShop);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const domain = shop.trim().toLowerCase();
    onSave(
      kind === "app"
        ? { shop: domain, client_id: clientId.trim(), client_secret: secret.trim() }
        : { shop: domain, token: secret.trim() },
    ).catch((err: Error) => (setError(err.message), setSaving(false)));
  };
  return (
    <Modal title="Connect the shop" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <p>
          Make an app in the Shopify Dev Dashboard, in the same organization as the shop, with the scopes{" "}
          <span className="mono">read_orders</span>, <span className="mono">read_all_orders</span>,{" "}
          <span className="mono">read_customers</span> and <span className="mono">read_shopify_payments_disputes</span>.
          Install it on the shop. Without <span className="mono">read_all_orders</span>, Shopify gives only the last 60
          days.
        </p>
        <TabStrip label="Kind of app">
          <Tab on={kind === "app"} onSelect={() => (setKind("app"), setSecret(""))}>
            Dev Dashboard app
          </Tab>
          <Tab on={kind === "token"} onSelect={() => (setKind("token"), setSecret(""))}>
            Custom app in the admin
          </Tab>
        </TabStrip>
        <label className="field">
          <span>Shop domain</span>
          <input
            className="input mono"
            value={shop}
            onChange={(e) => setShop(e.target.value)}
            placeholder="example-store.myshopify.com"
            required
            autoFocus
          />
        </label>
        {kind === "app" && (
          <label className="field">
            <span>Client ID</span>
            <input
              className="input mono"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              required
              autoComplete="off"
            />
          </label>
        )}
        <label className="field">
          <span>{kind === "app" ? "Client secret" : "Admin API access token"}</span>
          <input
            className="input mono"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            required
            autoComplete="off"
          />
        </label>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving}>
            {saving ? "Checking…" : "Connect"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SecretForm({
  mode,
  onClose,
  onSave,
}: {
  mode: "replace" | "add";
  onClose: () => void;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={mode === "add" ? "Add a second secret" : "Replace the secret"} onClose={onClose}>
      <form
        className="modal-body"
        onSubmit={(e) => (e.preventDefault(), onSave(value.trim()).catch((err: Error) => setError(err.message)))}
      >
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <p>
          {mode === "add"
            ? "Deliveries signed with either secret are accepted. When the provider uses only the new one, replace the secrets with it."
            : "Deliveries are checked with this secret only, from now on."}
        </p>
        <input
          className="input mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          autoFocus
          autoComplete="off"
        />
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function SourceDelivery({
  workspace,
  webhook,
  id,
  onClose,
  onSample,
  onReplayed,
}: {
  workspace: Workspace;
  webhook: Webhook;
  id: string;
  onClose: () => void;
  onSample: (sample: Sample) => void;
  onReplayed: (r: { replayed: number; statuses: Record<string, number> }) => void;
}) {
  const { data, error } = useApi(["webhook-delivery", workspace.id, webhook.id, id], () =>
    webhooks.delivery(workspace.id, webhook.id, id),
  );
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <Modal title="Delivery" onClose={onClose} wide>
      <div className="modal-body">
        {(error ?? failed) && (
          <div className="banner" style={{ margin: 0 }}>
            {error?.message ?? failed}
          </div>
        )}
        {!data ? (
          <Loading />
        ) : (
          <>
            <div className="wh-facts">
              <div>
                <span>Status</span>
                <span className={`chip ${TONE[data.status] ?? ""}`}>{LABEL[data.status] ?? data.status}</span>
              </div>
              <div>
                <span>Provider event</span>
                <b className="mono">{data.type ?? "—"}</b>
              </div>
              <div>
                <span>Provider id</span>
                <b className="mono">{data.external_id ?? "—"}</b>
              </div>
              <div>
                <span>Received</span>
                <b className="mono">{stamp(data.created)} UTC</b>
              </div>
              {data.result && (
                <div>
                  <span>Stored</span>
                  <b className="mono">
                    {data.result.events} {data.result.events === 1 ? "event" : "events"}, {data.result.labels}{" "}
                    {data.result.labels === 1 ? "label" : "labels"}
                  </b>
                </div>
              )}
            </div>
            {data.problem && (
              <div className="banner" style={{ margin: 0 }}>
                {data.problem}
              </div>
            )}
            {data.result?.unresolved && <p className="note">Not found: {data.result.unresolved.join("; ")}.</p>}
            {data.result?.event_ids.length ? (
              <p className="note">
                Events: <span className="mono">{data.result.event_ids.join(", ")}</span>
              </p>
            ) : null}
            <div className="wh-pre">
              <h3>Payload</h3>
              <pre>
                {data.payload === null
                  ? data.status === "rejected"
                    ? "Not kept: the delivery was not verified."
                    : "No longer kept."
                  : JSON.stringify(data.payload, null, 2)}
              </pre>
            </div>
            {data.headers && (
              <div className="wh-pre">
                <h3>Headers (without secrets)</h3>
                <pre>
                  {Object.entries(data.headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join("\n")}
                </pre>
              </div>
            )}
            <div className="modal-foot">
              <button className="btn" onClick={onClose}>
                Close
              </button>
              {data.payload !== null && (
                <>
                  <button
                    className="btn"
                    onClick={() => onSample({ body: data.payload, headers: data.headers ?? undefined })}
                  >
                    Use as sample
                  </button>
                  <button
                    className="btn primary"
                    onClick={() =>
                      webhooks
                        .replay(workspace.id, webhook.id, { delivery: data.id })
                        .then(onReplayed, (e: Error) => setFailed(e.message))
                    }
                  >
                    Run again
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function valueText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function textValue(text: string): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  if (/^[{[]|^-?\d+(\.\d+)?$|^(true|false)$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return text;
    }
  }
  return text;
}

type Insert = (path: string) => void;

/** Clicking a value in the sample puts its path in the field that was used last. */
function ValueField({
  value,
  onChange,
  placeholder,
  focus,
  mono = true,
}: {
  value: unknown;
  onChange: (v: any) => void;
  placeholder?: string;
  focus: (insert: Insert) => void;
  mono?: boolean;
}) {
  const [text, setText] = useState(valueText(value));
  useEffect(() => setText(valueText(value)), [JSON.stringify(value)]);
  const bad =
    text.trim().startsWith("{") &&
    (() => {
      try {
        JSON.parse(text);
        return false;
      } catch {
        return true;
      }
    })();
  return (
    <input
      className={`input ${mono ? "mono" : ""} ${bad ? "bad" : ""}`}
      value={text}
      placeholder={placeholder}
      onFocus={() => focus((path) => (setText(path), onChange(path)))}
      onChange={(e) => {
        setText(e.target.value);
        const v = textValue(e.target.value);
        if (!(e.target.value.trim().startsWith("{") && typeof v === "string")) onChange(v);
      }}
      title={bad ? "Not valid JSON yet" : undefined}
    />
  );
}

function PairRows({
  value,
  onChange,
  focus,
  namePlaceholder,
  valuePlaceholder,
}: {
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  focus: (insert: Insert) => void;
  namePlaceholder: string;
  valuePlaceholder: string;
}) {
  const entries = Object.entries(value);
  const set = (i: number, name: string, v: unknown) =>
    onChange(Object.fromEntries(entries.map((e, j) => (j === i ? [name, v] : e))));
  return (
    <div className="map-pairs">
      {entries.map(([name, v], i) => (
        <div key={i} className="map-pair">
          <input
            className="input mono"
            value={name}
            placeholder={namePlaceholder}
            onChange={(e) => set(i, e.target.value, v)}
          />
          <ValueField value={v} onChange={(nv) => set(i, name, nv)} focus={focus} placeholder={valuePlaceholder} />
          <button
            type="button"
            className="icon-btn"
            aria-label="Remove"
            onClick={() => onChange(Object.fromEntries(entries.filter((_, j) => j !== i)))}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn ghost"
        onClick={() => onChange({ ...value, [`${namePlaceholder.split(" ")[0]}_${entries.length + 1}`]: "" })}
      >
        + Add
      </button>
    </div>
  );
}

function Labeled({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <label className="map-field">
      <span>{title}</span>
      {children}
      {note && <small>{note}</small>}
    </label>
  );
}

function RuleCard({
  rule,
  index,
  count,
  onChange,
  onMove,
  onRemove,
  focus,
}: {
  rule: MappingRule;
  index: number;
  count: number;
  onChange: (r: MappingRule) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  focus: (insert: Insert) => void;
}) {
  const e = rule.event;
  const l = rule.label;
  const setEvent = (patch: Partial<MappingEvent>) => onChange({ ...rule, event: { ...(e as MappingEvent), ...patch } });
  const setLabel = (patch: Partial<MappingLabel>) => onChange({ ...rule, label: { ...(l as MappingLabel), ...patch } });
  const matchRows = Object.fromEntries(
    Object.entries(rule.match ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]),
  );
  const advanced = e && (e.set || e.set_once || (e.properties && "all" in e.properties));
  return (
    <div className="map-rule">
      <div className="map-rule-head">
        <input
          className="input"
          value={rule.name ?? ""}
          placeholder={`Rule ${index + 1}`}
          onChange={(ev) => onChange({ ...rule, name: ev.target.value || undefined })}
        />
        <div className="row">
          <button type="button" className="icon-btn" aria-label="Up" disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Down"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button type="button" className="icon-btn" aria-label="Remove rule" onClick={onRemove}>
            ×
          </button>
        </div>
      </div>

      <div className="map-section">
        <h4>When</h4>
        <small>
          A field of the payload (without $.) and the values it may have, separated by commas. No condition: every
          delivery.
        </small>
        <div className="map-pairs">
          {Object.entries(matchRows).map(([k, v], i) => (
            <div key={i} className="map-pair">
              <input
                className="input mono"
                value={k}
                placeholder="type"
                onChange={(ev) =>
                  onChange({
                    ...rule,
                    match: Object.fromEntries(
                      Object.entries(rule.match ?? {}).map(([kk, vv], j) =>
                        j === i ? [ev.target.value, vv] : [kk, vv],
                      ),
                    ),
                  })
                }
              />
              <input
                className="input mono"
                value={v}
                placeholder="payment.created, payment.updated"
                onChange={(ev) => {
                  const list = ev.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean);
                  onChange({ ...rule, match: { ...rule.match, [k]: list.length > 1 ? list : (list[0] ?? "") } });
                }}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label="Remove"
                onClick={() =>
                  onChange({
                    ...rule,
                    match: Object.fromEntries(Object.entries(rule.match ?? {}).filter((_, j) => j !== i)),
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn ghost"
            onClick={() =>
              onChange({
                ...rule,
                match: {
                  ...rule.match,
                  [Object.keys(rule.match ?? {}).includes("type")
                    ? `field_${Object.keys(rule.match ?? {}).length + 1}`
                    : "type"]: "",
                },
              })
            }
          >
            + Add condition
          </button>
        </div>
        {Object.keys(rule.match_headers ?? {}).length > 0 && (
          <small>
            And the request headers:{" "}
            <span className="mono">
              {Object.entries(rule.match_headers!)
                .map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join(", ") : String(v)}`)
                .join("; ")}
            </span>
            . Change them with "Edit as JSON".
          </small>
        )}
        <Labeled
          title="For each element of (optional)"
          note="A path to a list: the rule runs once for each element, which is $$."
        >
          <ValueField
            value={rule.items}
            onChange={(v) => onChange({ ...rule, items: v || undefined })}
            focus={focus}
            placeholder="$.data.items"
          />
        </Labeled>
      </div>

      <div className="map-section">
        <label className="check-line">
          <input
            type="checkbox"
            checked={!!e}
            onChange={(ev) =>
              onChange({
                ...rule,
                event: ev.target.checked ? { id: "$.id", type: "", entities: { user: "" } } : undefined,
              })
            }
          />
          <h4>Makes an event</h4>
        </label>
        {e && (
          <>
            <div className="map-grid">
              <Labeled title="Id" note="The provider's id: a retry stores nothing twice.">
                <ValueField value={e.id} onChange={(v) => setEvent({ id: v })} focus={focus} placeholder="$.id" />
              </Labeled>
              <Labeled title="Type" note="A name such as payment, or a path.">
                <ValueField
                  value={e.type}
                  onChange={(v) => setEvent({ type: v })}
                  focus={focus}
                  placeholder="payment"
                />
              </Labeled>
              <Labeled title="Time" note="Empty: when it arrives.">
                <TimeField value={e.ts} onChange={(v) => setEvent({ ts: v })} focus={focus} />
              </Labeled>
              <Labeled title="Record id (optional)" note="Stages of one thing share it.">
                <ValueField
                  value={e.universal_id}
                  onChange={(v) => setEvent({ universal_id: v })}
                  focus={focus}
                  placeholder="$.data.object.id"
                />
              </Labeled>
              <Labeled title="Status (optional)" note='The stage. {"path": …, "values": {…}} renames.'>
                <ValueField
                  value={e.status}
                  onChange={(v) => setEvent({ status: v })}
                  focus={focus}
                  placeholder="$.data.object.status"
                />
              </Labeled>
              <Labeled title="Session (optional)">
                <ValueField
                  value={e.session}
                  onChange={(v) => setEvent({ session: v })}
                  focus={focus}
                  placeholder="$.session_id"
                />
              </Labeled>
            </div>
            <h5>Entities</h5>
            <small>
              {
                'Type → the id in the payload. To find it from what Kairos knows: {"record": "$.payment_id"} or {"lookup": {"property": "stripe_customer_id", "value": "$.customer"}}.'
              }
            </small>
            <PairRows
              value={e.entities as Record<string, unknown>}
              onChange={(v) => setEvent({ entities: v as Record<string, EntityValue> })}
              focus={focus}
              namePlaceholder="user"
              valuePlaceholder="$.data.user_id"
            />
            <h5>Properties</h5>
            {e.properties && "all" in e.properties ? (
              <small>Every field of {String(e.properties.all)}. Change it with "Edit as JSON".</small>
            ) : (
              <PairRows
                value={(e.properties ?? {}) as Record<string, unknown>}
                onChange={(v) => setEvent({ properties: v as Record<string, MappingValue> })}
                focus={focus}
                namePlaceholder="amount_minor"
                valuePlaceholder="$.data.amount"
              />
            )}
            {advanced && (
              <small>
                This rule also sets entity properties or takes all fields of an object: change those with "Edit as
                JSON".
              </small>
            )}
          </>
        )}
      </div>

      <div className="map-section">
        <label className="check-line">
          <input
            type="checkbox"
            checked={!!l}
            onChange={(ev) =>
              onChange({
                ...rule,
                label: ev.target.checked
                  ? { entity: Object.keys(e?.entities ?? { user: "" })[0] ?? "user", label: "" }
                  : undefined,
              })
            }
          />
          <h4>Puts a label on an entity</h4>
        </label>
        {l && (
          <div className="map-grid">
            <Labeled title="Entity type" note="One of the event's, or give an id.">
              <input
                className="input mono"
                value={l.entity}
                onChange={(ev) => setLabel({ entity: ev.target.value })}
                placeholder="user"
              />
            </Labeled>
            <Labeled title="Entity id (optional)" note="Empty: the event's entity of that type.">
              <ValueField
                value={l.id}
                onChange={(v) => setLabel({ id: v })}
                focus={focus}
                placeholder="$.data.user_id"
              />
            </Labeled>
            <Labeled title="Label" note="A name such as chargeback.">
              <ValueField
                value={l.label}
                onChange={(v) => setLabel({ label: v })}
                focus={focus}
                placeholder="chargeback"
              />
            </Labeled>
          </div>
        )}
      </div>
    </div>
  );
}

const FORMATS = [
  ["iso", "ISO 8601"],
  ["unix_seconds", "Unix seconds"],
  ["unix_ms", "Unix milliseconds"],
] as const;

/** Anything more (a default) is edited as JSON. */
function TimeField({
  value,
  onChange,
  focus,
}: {
  value: MappingValue | undefined;
  onChange: (v: MappingValue | undefined) => void;
  focus: (insert: Insert) => void;
}) {
  const object = value && typeof value === "object" ? value : null;
  if (object && ("join" in object || Object.keys(object).some((k) => k !== "path" && k !== "format")))
    return <ValueField value={value} onChange={onChange} focus={focus} />;
  const path = object ? object.path : (value as string | undefined);
  const format = object?.format ?? "iso";
  const make = (p: unknown, f: string) =>
    p === undefined || p === "" ? undefined : f === "iso" ? p : { path: String(p), format: f as "unix_seconds" };
  return (
    <div className="map-time">
      <ValueField
        value={path}
        onChange={(p) => onChange(make(p, format) as MappingValue)}
        focus={focus}
        placeholder="$.created"
      />
      <select className="input" value={format} onChange={(e) => onChange(make(path, e.target.value) as MappingValue)}>
        {FORMATS.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A click on a value gives its path to the field used last. */
function Tree({ value, path, onPick }: { value: unknown; path: string; onPick: (path: string) => void }): ReactNode {
  if (value === null || typeof value !== "object") {
    return (
      <button type="button" className="tree-leaf" onClick={() => onPick(path)} title={`Use ${path}`}>
        {JSON.stringify(value)}
      </button>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [i, v] as const) : Object.entries(value);
  return (
    <div className="tree">
      {entries.map(([key, v]) => {
        const next =
          typeof key === "number"
            ? `${path}[${key}]`
            : /^[A-Za-z_$][\w$-]*$/.test(key)
              ? `${path}.${key}`
              : `${path}["${key}"]`;
        const leaf = v === null || typeof v !== "object";
        return (
          <div key={String(key)} className={leaf ? "tree-row" : "tree-node"}>
            <span className="tree-key">{typeof key === "number" ? `[${key}]` : key}</span>
            {leaf ? <Tree value={v} path={next} onPick={onPick} /> : <Tree value={v} path={next} onPick={onPick} />}
          </div>
        );
      })}
    </div>
  );
}

const listText = (v: string | number | boolean | (string | number | boolean)[]) => {
  const all = Array.isArray(v) ? v.map(String) : [String(v)];
  return all.length > 3 ? `${all.slice(0, 3).join(", ")} +${all.length - 3}` : all.join(", ");
};

function shortValue(v: MappingValue | undefined): string {
  if (v === undefined) return "";
  if (typeof v !== "object") return String(v);
  if ("join" in v) return "joined value";
  if (v.values) return [...new Set(Object.values(v.values).map(String))].join(" / ");
  return v.path;
}

function ruleWhen(rule: MappingRule): string {
  const parts = [
    ...Object.entries(rule.match ?? {}).map(([k, v]) => `${k} = ${listText(v)}`),
    ...Object.entries(rule.match_headers ?? {}).map(([k, v]) => `${k} header = ${listText(v)}`),
  ];
  return [parts.length ? parts.join(" · ") : "Every delivery", rule.items && `each of ${rule.items}`]
    .filter(Boolean)
    .join(" · ");
}

function MappingSummary({ mapping }: { mapping: WebhookMapping }) {
  return (
    <div className="card table-wrap">
      <table className="mapping-summary">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Makes</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {mapping.rules.map((rule, i) => (
            <tr key={i}>
              <td>
                <b>{rule.name || `Rule ${i + 1}`}</b>
              </td>
              <td>
                <div className="chips">
                  {rule.event && <span className="chip">{shortValue(rule.event.type) || "event"}</span>}
                  {rule.label && <span className="chip warn">label {shortValue(rule.label.label)}</span>}
                </div>
              </td>
              <td className="mono muted">{ruleWhen(rule)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mapping-summary-foot">
        When no rule matches: {mapping.unmatched === "fail" ? "the delivery is recorded as failed" : "it is ignored"}.
      </p>
    </div>
  );
}

function MappingEditor({
  initial,
  allowSet,
  samples,
  deliveries,
  loadDelivery,
  external,
  onChanged,
  onSave,
}: {
  initial: WebhookMapping;
  allowSet: boolean;
  samples: (Sample & { label: string })[];
  deliveries: WebhookDelivery[];
  loadDelivery: (id: string) => Promise<Sample>;
  external: Sample | undefined;
  /** Whether the mapping differs from the saved one, so that closing can ask first. */
  onChanged?: (changed: boolean) => void;
  onSave: (mapping: WebhookMapping) => Promise<unknown>;
}) {
  const [mapping, setMapping] = useState<WebhookMapping>(initial);
  const [json, setJson] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [sampleText, setSampleText] = useState(() => (samples[0] ? JSON.stringify(samples[0].body, null, 2) : ""));
  const [headerText, setHeaderText] = useState(() => headersText(samples[0]?.headers));
  const [headersOpen, setHeadersOpen] = useState(!!headerText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const insert = useRef<Insert | null>(null);
  const focus = (fn: Insert) => (insert.current = fn);
  const changed = JSON.stringify(mapping) !== JSON.stringify(initial);
  const use = (s: Sample) => {
    setSampleText(JSON.stringify(s.body, null, 2));
    setHeaderText(headersText(s.headers));
    if (headersText(s.headers)) setHeadersOpen(true);
  };

  useEffect(() => onChanged?.(changed), [changed]);
  useEffect(() => {
    if (external !== undefined) use(external);
  }, [external]);
  // The preset's samples load after the editor: the first one becomes the sample, unless one was given.
  useEffect(() => {
    if (samples[0] && !sampleText) use(samples[0]);
  }, [samples.length]);

  const sample = useMemo(() => {
    if (!sampleText.trim()) return { body: undefined, error: null };
    try {
      return { body: JSON.parse(sampleText) as unknown, error: null };
    } catch {
      return { body: undefined, error: "The sample is not valid JSON." };
    }
  }, [sampleText]);
  const headers = useMemo(() => {
    if (!headerText.trim()) return { value: {}, error: null };
    let value: unknown;
    try {
      value = JSON.parse(headerText);
    } catch {
      value = null;
    }
    if (value && typeof value === "object" && !Array.isArray(value))
      return { value: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)])), error: null };
    return { value: {}, error: 'The headers must be a JSON object, such as {"X-Topic": "orders/create"}.' };
  }, [headerText]);
  const problems = useMemo(() => validateMapping(mapping, { allowSet }), [mapping, allowSet]);
  const result = useMemo(
    () =>
      problems.length || sample.body === undefined
        ? null
        : applyMapping(mapping, { body: sample.body, headers: headers.value }, new Date().toISOString()),
    [mapping, sample.body, headers.value, problems],
  );

  const setRule = (i: number, rule: MappingRule) =>
    setMapping({ ...mapping, rules: mapping.rules.map((r, j) => (j === i ? rule : r)) });
  const move = (i: number, d: -1 | 1) => {
    const rules = [...mapping.rules];
    [rules[i], rules[i + d]] = [rules[i + d]!, rules[i]!];
    setMapping({ ...mapping, rules });
  };
  const save = () => {
    setSaving(true);
    setError(null);
    onSave(mapping)
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="map-editor">
      <div className="card pad map-sample">
        <div className="map-sample-head">
          <h3>Sample payload</h3>
          <select
            className="input"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v.startsWith("sample:")) use(samples[Number(v.slice(7))]!);
              if (v.startsWith("delivery:"))
                loadDelivery(v.slice(9)).then(
                  (s) => s.body !== null && use(s),
                  () => {},
                );
            }}
          >
            <option value="">Take one from…</option>
            {samples.map((s, i) => (
              <option key={`s${i}`} value={`sample:${i}`}>
                {s.label}
              </option>
            ))}
            {deliveries.slice(0, 20).map((d) => (
              <option key={d.id} value={`delivery:${d.id}`}>
                Delivery {stamp(d.created)} · {d.type ?? d.status}
              </option>
            ))}
          </select>
        </div>
        <textarea
          className="input mono map-sample-text"
          rows={8}
          value={sampleText}
          onChange={(e) => setSampleText(e.target.value)}
          placeholder="Paste a payload from the provider's documentation or dashboard."
        />
        {sample.error && <small className="wh-failed">{sample.error}</small>}
        <details
          className="map-headers"
          open={headersOpen}
          onToggle={(e) => setHeadersOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>Request headers</summary>
          <textarea
            className="input mono"
            rows={4}
            value={headerText}
            onChange={(e) => setHeaderText(e.target.value)}
            placeholder={'{"X-Shopify-Topic": "orders/create"}'}
          />
          <small>For a mapping that reads a header, or matches on one.</small>
        </details>
        {headers.error && <small className="wh-failed">{headers.error}</small>}
        {sample.body !== undefined && (
          <>
            <small>Click a value to put its path in the field you used last.</small>
            <div className="tree-wrap">
              <Tree value={sample.body} path="$" onPick={(p) => insert.current?.(p)} />
            </div>
          </>
        )}
      </div>

      <div className="map-rules">
        <div className="row wrap" style={{ justifyContent: "space-between" }}>
          <div className="seg">
            <button
              className={json === null ? "on" : ""}
              onClick={() => (setJson(null), setJsonError(null))}
              disabled={json !== null && !!jsonError}
            >
              Form
            </button>
            <button className={json !== null ? "on" : ""} onClick={() => setJson(JSON.stringify(mapping, null, 2))}>
              Edit as JSON
            </button>
          </div>
          <div className="row">
            {changed && (
              <button className="btn" onClick={() => (setMapping(initial), setJson(null))}>
                Undo changes
              </button>
            )}
            <button className="btn primary" disabled={!changed || problems.length > 0 || saving} onClick={save}>
              {saving ? "Saving…" : "Save mapping"}
            </button>
          </div>
        </div>
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        {json !== null ? (
          <>
            <textarea
              className="input mono map-json"
              rows={24}
              value={json}
              onChange={(e) => {
                setJson(e.target.value);
                try {
                  setMapping(JSON.parse(e.target.value) as WebhookMapping);
                  setJsonError(null);
                } catch {
                  setJsonError("Not valid JSON yet.");
                }
              }}
            />
            {jsonError && <small className="wh-failed">{jsonError}</small>}
          </>
        ) : (
          <>
            {mapping.rules.map((rule, i) => (
              <RuleCard
                key={i}
                rule={rule}
                index={i}
                count={mapping.rules.length}
                onChange={(r) => setRule(i, r)}
                onMove={(d) => move(i, d)}
                onRemove={() => setMapping({ ...mapping, rules: mapping.rules.filter((_, j) => j !== i) })}
                focus={focus}
              />
            ))}
            <div className="row wrap">
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setMapping({
                    ...mapping,
                    rules: [
                      ...mapping.rules,
                      {
                        name: `Rule ${mapping.rules.length + 1}`,
                        event: { id: "$.id", type: "", entities: { user: "" } },
                      },
                    ],
                  })
                }
              >
                + Add rule
              </button>
              <label className="check-line">
                <span className="muted">When no rule matches:</span>
                <select
                  className="input"
                  style={{ width: "auto" }}
                  value={mapping.unmatched ?? "ignore"}
                  onChange={(e) => setMapping({ ...mapping, unmatched: e.target.value as "ignore" })}
                >
                  <option value="ignore">Ignore the delivery</option>
                  <option value="fail">Record it as failed</option>
                </select>
              </label>
            </div>
          </>
        )}

        <div className="card pad map-preview">
          <h3>Result on the sample</h3>
          {problems.length > 0 ? (
            <ul className="map-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : !result ? (
            <p className="note">Paste or choose a sample payload to see what it gives.</p>
          ) : (
            <Preview result={result} />
          )}
        </div>
      </div>
    </div>
  );
}

function Preview({ result }: { result: ReturnType<typeof applyMapping> }) {
  const text: Record<string, string> = {
    mapped: `Stored: ${result.events.length} ${result.events.length === 1 ? "event" : "events"}, ${result.labels.length} ${result.labels.length === 1 ? "label" : "labels"}`,
    ignored: "Ignored: no rule matches this payload",
    failed: "Failed: nothing from it would be stored",
    no_entity: "No entity: nothing from it would be stored until its entity is found",
  };
  const lookupText = (type: string, l: { by: string; record?: string; property?: string; value?: string }) =>
    l.by === "record" ? `the ${type} of record ${l.record}` : `the ${type} whose ${l.property} is ${l.value}`;
  return (
    <>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <span className={`chip ${result.outcome === "mapped" ? "ok" : result.outcome === "ignored" ? "" : "warn"}`}>
          {result.outcome}
        </span>
        <span>{text[result.outcome]}</span>
        {result.matched.length > 0 && <span className="muted">· rules {result.matched.join(", ")}</span>}
      </div>
      {result.problems.map((p) => (
        <div key={p} className="banner" style={{ margin: "0 0 8px" }}>
          {p}
        </div>
      ))}
      {result.events.map((e) => (
        <div key={e.id} className="map-result">
          <div>
            <b className="mono">{e.type}</b> <span className="muted mono">{e.id}</span>{" "}
            <span className="muted">
              {dayOf(e.ts)} {e.ts.slice(11, 19)} UTC
            </span>
            {e.status && <span className="chip">{e.status}</span>}
          </div>
          {(e.universal_id || e.session) && (
            <div className="muted">
              {e.universal_id && (
                <>
                  record <span className="mono">{e.universal_id}</span>
                </>
              )}
              {e.universal_id && e.session && " · "}
              {e.session && (
                <>
                  session <span className="mono">{e.session}</span>
                </>
              )}
            </div>
          )}
          <div className="chips">
            {Object.entries(e.entities).map(([t, id]) => (
              <span key={t} className="chip accent">
                {t} {id}
              </span>
            ))}
            {Object.entries(e.lookups ?? {}).map(([t, l]) => (
              <span key={t} className="chip review" title="Found when the delivery is stored">
                {t}: {lookupText(t, l)}
              </span>
            ))}
          </div>
          {Object.keys(e.properties).length > 0 && <pre>{JSON.stringify(e.properties, null, 2)}</pre>}
        </div>
      ))}
      {result.labels.map((l, i) => (
        <div key={i} className="map-result">
          <b>Label</b> <span className="chip warn">{l.label}</span> on{" "}
          {l.entity.id ? (
            <span className="mono">
              {l.entity.type} {l.entity.id}
            </span>
          ) : (
            lookupText(l.entity.type, l.lookup!)
          )}
        </div>
      ))}
    </>
  );
}
