import { useEffect, useState } from "react";
import {
  EntityColor,
  EntityIcon as IconName,
  KINDS,
  suggestKind,
  PROPERTY_FORMATS,
  type EntityCommand,
  type EntityFact,
  type EntityList as ListDefinition,
  type PropertyFormat,
} from "@kairos/core";
import { api } from "../../api/index";
import type { EntityDefinition } from "../../types/interfaces";
import { DisplayCard } from "../../components/entities/DisplayCard";
import { cleanCommand, CommandsEditor } from "../../components/entities/Commands";
import { FactsEditor, ListsEditor } from "../../components/entities/FactsListsEditor";
import { Card } from "../../components/ui/Card";
import { type Pair, Pairs } from "../../components/ui/Pairs";
import { Failure } from "../../components/ui/states";
import { COLUMN_FORMAT_LABEL } from "../../lib/facts";
import { entityName, valueText } from "../../lib/format";
import { useApi } from "../../hooks/useApi";
import { go } from "../../lib/route";
import { EntityShapeCard } from "../../components/entities/EntityShapeCard";

const CUSTOM = "__custom__";

const FORMAT_LABEL: Record<PropertyFormat, string> = {
  ...COLUMN_FORMAT_LABEL,
  image: "Image",
  document: "Document",
  link: "Link",
};

function suggestedFormat(example: unknown): PropertyFormat | undefined {
  if (typeof example !== "string") return undefined;
  if (/^data:image\//i.test(example) || /^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif|bmp)(\?|$)/i.test(example))
    return "image";
  if (/^data:application\/pdf/i.test(example) || /^https?:\/\/\S+\.pdf(\?|$)/i.test(example)) return "document";
  return undefined;
}

function FormatsCard({
  names,
  examples,
  formats,
  onChange,
}: {
  names: string[];
  examples: Record<string, unknown>;
  formats: Record<string, PropertyFormat>;
  onChange: (formats: Record<string, PropertyFormat>) => void;
}) {
  const set = (name: string, format: PropertyFormat | "") => {
    const { [name]: _, ...rest } = formats;
    onChange(format ? { ...rest, [name]: format } : rest);
  };
  return (
    <Card title="How properties show">
      <p className="section-note">
        An image or a document is read through Kairos, from the hosts approved in Settings › Workspace or from a data
        address, and shows only when a person opens it.
      </p>
      {names.length === 0 ? (
        <span className="muted">No properties yet.</span>
      ) : (
        <div className="format-list">
          {names.map((name) => {
            const suggested = suggestedFormat(examples[name]);
            return (
              <div key={name} className="format-row">
                <span className="mono">{name}</span>
                <span className="muted grow format-example">
                  {examples[name] === undefined ? "" : valueText(examples[name])}
                </span>
                {suggested && !formats[name] && (
                  <button type="button" className="btn ghost compact" onClick={() => set(name, suggested)}>
                    Show as {FORMAT_LABEL[suggested].toLowerCase()}
                  </button>
                )}
                <select
                  className="input compact"
                  aria-label={`Format of ${name}`}
                  value={formats[name] ?? ""}
                  onChange={(e) => set(name, e.target.value as PropertyFormat | "")}
                >
                  <option value="">As its value</option>
                  {PROPERTY_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {FORMAT_LABEL[f]}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function EntityTypeEditorPage({ type }: { type: string }) {
  const isNew = type === "new";
  const { data: existing } = useApi(["entity-type", type], () => api.entityType(type).catch(() => null), {
    enabled: !isNew,
  });
  const [draft, setDraft] = useState<{
    type: string;
    kind: string;
    description: string;
    link: boolean;
    properties: Pair[];
    icon: IconName | "";
    color: EntityColor | "";
    fields: string[];
    formats: Record<string, PropertyFormat>;
    facts: EntityFact[];
    lists: ListDefinition[];
    commands: EntityCommand[];
  }>({
    type: isNew ? "" : type,
    kind: "",
    description: "",
    link: true,
    properties: [],
    icon: "",
    color: "",
    fields: [],
    formats: {},
    facts: [],
    lists: [],
    commands: [],
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customKind, setCustomKind] = useState(false);
  const { data: shape } = useApi(["entity-shape", type], () => api.entityShape(type).catch(() => null), {
    enabled: !isNew,
  });
  useEffect(() => {
    if (existing) setCustomKind(!!existing.kind && !(existing.kind in KINDS));
  }, [existing]);
  useEffect(() => {
    if (existing)
      setDraft({
        type: existing.type,
        kind: existing.kind ?? "",
        description: existing.description ?? "",
        link: existing.link !== false,
        properties: Object.entries(existing.properties ?? {}),
        icon: existing.display?.icon ?? "",
        color: existing.display?.color ?? "",
        fields: existing.display?.fields ?? [],
        formats: existing.display?.formats ?? {},
        facts: existing.facts ?? [],
        lists: existing.lists ?? [],
        commands: existing.commands ?? [],
      });
  }, [existing]);
  const set = (patch: Partial<typeof draft>) => (setDraft({ ...draft, ...patch }), setSaved(false));
  const { data: templateList } = useApi(["entity-templates"], () => api.entityTemplates());
  const templates = templateList?.templates ?? [];
  const startFrom = (t: EntityDefinition) =>
    set({
      type: draft.type.trim() || t.type,
      kind: draft.kind || t.kind || "",
      description: draft.description || t.description || "",
      icon: draft.icon || t.display?.icon || "",
      color: draft.color || t.display?.color || "",
      facts: t.facts ?? [],
      lists: t.lists ?? [],
    });

  const save = async () => {
    setError(null);
    const definition: EntityDefinition = {
      type: draft.type.trim(),
      ...(draft.kind.trim() ? { kind: draft.kind.trim() } : {}),
      ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      link: draft.link,
      ...(draft.properties.length
        ? { properties: Object.fromEntries(draft.properties.map(([name, text]) => [name.trim(), text.trim()])) }
        : {}),
      ...(draft.icon || draft.color || draft.fields.length || Object.keys(draft.formats).length
        ? {
            display: {
              ...(draft.icon ? { icon: draft.icon } : {}),
              ...(draft.color ? { color: draft.color } : {}),
              ...(draft.fields.length ? { fields: draft.fields } : {}),
              ...(Object.keys(draft.formats).length ? { formats: draft.formats } : {}),
            },
          }
        : {}),
      ...(draft.facts.length ? { facts: draft.facts } : {}),
      ...(draft.lists.length ? { lists: draft.lists } : {}),
      ...(draft.commands.length ? { commands: draft.commands.map(cleanCommand) } : {}),
    };
    try {
      const stored = await api.saveEntityType(definition);
      setSaved(true);
      if (isNew) go("entities", stored.type);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>{isNew ? "Define entity" : `${entityName(type)} definition`}</h1>
          <p className="lede">
            Say what this kind of entity is. A definition is optional: events can name a type that no one defined. It
            documents the type and controls whether sharing one links two subjects.
          </p>
        </div>
        <button className="btn primary" onClick={save}>
          {isNew ? "Create entity" : "Save definition"}
        </button>
      </header>
      {error && <Failure message={error} />}
      {saved && <div className="banner ok">Saved.</div>}
      <div className="split">
        <div className="stack">
          <Card title="The entity">
            <div className="stack" style={{ gap: 16 }}>
              {isNew && templates.length > 0 && (
                <label className="field">
                  <span>Start from a template</span>
                  <select
                    className="input"
                    value=""
                    onChange={(e) => {
                      const t = templates.find((x) => x.type === e.target.value);
                      if (t) startFrom(t);
                    }}
                  >
                    <option value="">Choose a template…</option>
                    {templates.map((t) => (
                      <option key={t.type} value={t.type}>
                        {entityName(t.type)} — {t.description}
                      </option>
                    ))}
                  </select>
                  <small>Fills the kind, the display, the facts and the lists. Change any of them after.</small>
                </label>
              )}
              <label className="field">
                <span>Type</span>
                <input
                  className="input mono"
                  placeholder="merchant"
                  value={draft.type}
                  disabled={!isNew}
                  onChange={(e) => set({ type: e.target.value })}
                />
                <small>
                  The name used in events: <span className="mono">merchantId</span>, or{" "}
                  <span className="mono">entities: {"{ merchant: … }"}</span>.
                </small>
              </label>
              <label className="field">
                <span>Kind</span>
                <select
                  className="input"
                  value={customKind ? CUSTOM : draft.kind}
                  onChange={(e) =>
                    e.target.value === CUSTOM
                      ? (setCustomKind(true), set({ kind: "" }))
                      : (setCustomKind(false), set({ kind: e.target.value }))
                  }
                >
                  <option value="">None</option>
                  {Object.entries(KINDS).map(([kind, k]) => (
                    <option key={kind} value={kind}>
                      {kind[0]!.toUpperCase() + kind.slice(1)} — {k.is[0]!.toLowerCase() + k.is.slice(1)}
                    </option>
                  ))}
                  <option value={CUSTOM}>Custom…</option>
                </select>
                {customKind && (
                  <input
                    className="input mono"
                    placeholder="vehicle"
                    value={draft.kind}
                    onChange={(e) => set({ kind: e.target.value })}
                    autoFocus
                  />
                )}
                <small>
                  {customKind
                    ? "Your own kind. A name with letters, digits and underscores."
                    : draft.kind
                      ? `${KINDS[draft.kind as keyof typeof KINDS].is}.`
                      : "What sort of thing this is. Optional."}{" "}
                  {!draft.kind && !customKind && suggestKind(draft.type) && (
                    <a
                      className="linkish"
                      href="#"
                      onClick={(e) => (e.preventDefault(), set({ kind: suggestKind(draft.type)! }))}
                    >
                      Use "{suggestKind(draft.type)}"?
                    </a>
                  )}
                </small>
              </label>
              <label className="field">
                <span>Description</span>
                <textarea
                  className="input"
                  placeholder="A business that takes payments through us"
                  value={draft.description}
                  onChange={(e) => set({ description: e.target.value })}
                />
              </label>
            </div>
          </Card>
          {shape && (
            <EntityShapeCard
              shape={shape}
              documented={draft.properties.map(([name]) => name.trim())}
              onAdd={(name) => set({ properties: [...draft.properties, [name, ""]] })}
            />
          )}
          <Card title="Documented properties">
            <Pairs
              items={draft.properties}
              onChange={(properties) => set({ properties })}
              codeHint="country"
              textHint="Where the business is registered"
            />
            <p className="note" style={{ margin: "12px 0 0" }}>
              What an entity of this type carries. This documents the type; other properties are still accepted.
            </p>
          </Card>
          <FormatsCard
            names={[
              ...new Set([
                ...draft.properties.map(([name]) => name.trim()).filter(Boolean),
                ...(shape?.properties.map((p) => p.name) ?? []),
              ]),
            ]}
            examples={Object.fromEntries(shape?.properties.map((p) => [p.name, p.example]) ?? [])}
            formats={draft.formats}
            onChange={(formats) => set({ formats })}
          />
          <FactsEditor
            facts={draft.facts}
            saved={existing?.facts?.map((f) => f.name) ?? []}
            onChange={(facts) => set({ facts })}
            templates={templates}
            type={draft.type.trim()}
          />
          <ListsEditor
            lists={draft.lists}
            saved={existing?.lists?.map((l) => l.name) ?? []}
            onChange={(lists) => set({ lists })}
            templates={templates}
            type={draft.type.trim()}
          />
          <CommandsEditor commands={draft.commands} onChange={(commands) => set({ commands })} />
        </div>
        <aside className="stack">
          <DisplayCard
            type={draft.type}
            kind={draft.kind}
            icon={draft.icon}
            color={draft.color}
            fields={draft.fields}
            known={[
              ...new Set([
                ...draft.properties.map(([name]) => name.trim()).filter(Boolean),
                ...(shape?.properties.map((p) => p.name) ?? []),
              ]),
            ]}
            examples={Object.fromEntries(shape?.properties.map((p) => [p.name, p.example]) ?? [])}
            onChange={set}
          />
          <Card title="Linking">
            <label className={`check ${draft.link ? "on" : ""}`} style={{ width: "100%" }}>
              <input type="checkbox" checked={draft.link} onChange={(e) => set({ link: e.target.checked })} />
              Sharing one links two subjects
            </label>
            <p className="note" style={{ margin: "12px 0 0" }}>
              On for something one person normally controls: a device, a bank account. Turn it off for a type that
              should never connect subjects. An action's own link types override this.
            </p>
          </Card>
        </aside>
      </div>
    </>
  );
}
