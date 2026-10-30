import {
  BLOCK_TYPES,
  DEFAULT_VIEW,
  MAX_BLOCKS,
  MAX_BLOCK_FIELDS,
  MAX_HEADER_FIELDS,
  MAX_MEDIA,
  MAX_POINTS,
  MIN_WIDTH,
  REQUIRED_BLOCKS,
  VIEW_FIELDS,
  asColumn,
  validateView,
  viewFieldTitle,
  type BlockType,
  type CaseView,
  type EntityFact,
  type EntityList,
  type ViewBlock,
  type ViewField,
  type ViewRegion,
} from "@kairos/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { queues } from "../../api/index";
import { ColumnFormatControls, FactsEditor, ListsEditor } from "../../components/entities/FactsListsEditor";
import { InTopbar } from "../../components/shell/InTopbar";
import { Card } from "../../components/ui/Card";
import { ChoiceSelect } from "../../components/ui/ChoiceSelect";
import { ColumnPicker } from "../../components/ui/ColumnPicker";
import { Modal } from "../../components/ui/Modal";
import { MultiSelect } from "../../components/ui/MultiSelect";
import { Failure, Loading } from "../../components/ui/states";
import { TemplateModal } from "../../components/ui/TemplateModal";
import { useActionNames } from "../../hooks/useActionNames";
import { useActions, useApi, useEntityTypeList, useMembers } from "../../hooks/useApi";
import { useWorkspace } from "../../hooks/useWorkspace";
import { useEntityDefinitions } from "../../hooks/useEntityDefinitions";
import { entityName, stamp } from "../../lib/format";
import { STATUS_LABEL, definitionOf, ruleId } from "../../lib/queues";
import { go, href } from "../../lib/route";
import type { CaseViewData, EntityDefinition, ViewTemplate } from "../../types/interfaces";
import { CaseBlock, ValueText, type CaseContext } from "./CaseBlocks";

const BLOCK_LABEL: Record<BlockType, string> = {
  evidence: "Why this case exists",
  decisions: "Decisions",
  timeline: "What happened",
  details: "Details",
  fields: "Fields",
  facts: "Facts",
  list: "Lists",
  objects: "Objects",
  activity: "Activity and notes",
  text: "Instructions",
  images: "Images",
  documents: "Documents",
  checklist: "Checklist",
};

const BLOCK_NOTE: Record<BlockType, string> = {
  evidence: "Each trigger, with the rule and the values it read. Every page has it.",
  decisions: "The case's decisions, with their outcome, risk and resolution.",
  timeline: "The events and decisions in time order.",
  details: "Status, priority, assignee, queue, when it opened and when it is due.",
  fields: "Values you choose: of the case, its latest decision, the request, the event or its entities.",
  facts: "Numbers about the case's entity, or about one of its objects.",
  list: "Tables of the records about an entity, a tab each.",
  objects: "The entities, sessions and records of the case.",
  activity: "Assignments, notes and the resolution, with a field to add a note.",
  text: "Fixed instructions for the reviewer.",
  images:
    "Photos from fields that hold an image address, such as an ID and a selfie. Read through Kairos from approved hosts.",
  documents:
    "Files from fields that hold an address, such as a bank statement. Read through Kairos from approved hosts.",
  checklist: "Points a reviewer confirms. Each tick is recorded: who, and when.",
};

const FIELD_CUSTOM = {
  prefixes: ["request.", "event.", "subject.", "signal.", "item."],
  option: "A property, a signal, or a property of an object…",
  placeholder: "request.amount, event.channel, signal.new_device or item.device.os",
  note: "request. and event. are of the case's latest decision; subject. is of the case's entity; item.<type>. is of its first object of that type.",
};

const fieldsOf = (fields: ViewField[] | undefined) => (fields ?? []).map(asColumn);

function FieldPicker({
  fields,
  max,
  formats = true,
  onChange,
}: {
  fields: ViewField[] | undefined;
  max: number;
  /** False for fields that hold an address: they have no format. */
  formats?: boolean;
  onChange: (fields: ViewField[]) => void;
}) {
  const columns = fieldsOf(fields);
  return (
    <ColumnPicker
      columns={columns.map((c) => c.field)}
      onChange={(next) =>
        onChange(
          next.map((field) => {
            const kept = columns.find((c) => c.field === field);
            return kept && Object.keys(kept).length > 1 ? kept : field;
          }),
        )
      }
      options={VIEW_FIELDS}
      labelOf={(field) => viewFieldTitle(columns.find((c) => c.field === field) ?? field)}
      max={max}
      noun="field"
      custom={FIELD_CUSTOM}
      extra={(field) =>
        formats && (
          <ColumnFormatControls
            column={columns.find((c) => c.field === field)!}
            prefix="event."
            onChange={(column) => onChange(columns.map((c) => (c.field === field ? column : c)))}
          />
        )
      }
    />
  );
}

type LabelOf = (kind: "facts" | "lists", type: string, name: string) => string;

function blockSummary(b: ViewBlock, target: string, labelOf: LabelOf): string {
  const about =
    !b.of || b.of === "case.target" ? `the case's ${entityName(target).toLowerCase()}` : `its ${b.of.slice(5)}`;
  const type = typeOf(b.of, target);
  const labels = (kind: "facts" | "lists", names: string[]) => names.map((n) => labelOf(kind, type, n)).join(", ");
  if (b.type === "fields")
    return (
      fieldsOf(b.fields)
        .map((f) => viewFieldTitle(f))
        .join(", ") || "No fields yet"
    );
  if (b.type === "facts") return `${b.facts?.length ? labels("facts", b.facts) : "Every fact"}, about ${about}`;
  if (b.type === "list")
    return `${b.lists?.length ? labels("lists", b.lists) : "Every list"}, about ${about}, ${b.rows ?? 5} rows`;
  if (b.type === "text") return b.text ?? "";
  if (b.type === "images" || b.type === "documents")
    return `${
      fieldsOf(b.fields)
        .map((f) => viewFieldTitle(f))
        .join(", ") || "No fields yet"
    }${b.sensitive === false ? "" : ", hidden until opened"}`;
  if (b.type === "checklist") return (b.points ?? []).join("\n") || "No points yet";
  return BLOCK_NOTE[b.type];
}

const typeOf = (of: string | undefined, target: string) => (!of || of === "case.target" ? target : of.slice(5));

function BlockModal({
  block,
  view,
  target,
  definitions,
  entityTypes,
  onSave,
  onClose,
}: {
  block: ViewBlock;
  view: CaseView;
  target: string;
  definitions: Record<string, EntityDefinition | undefined>;
  entityTypes: string[];
  onSave: (block: ViewBlock) => void;
  onClose: () => void;
}) {
  const [b, setB] = useState(block);
  const set = (patch: Partial<ViewBlock>) => {
    const next = { ...b, ...patch } as ViewBlock & Record<string, unknown>;
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    setB(next);
  };
  const type = typeOf(b.of, target);
  const names = (kind: "facts" | "lists") => [
    ...new Set([
      ...(view[kind] ?? []).filter((d) => d.for === type).map((d) => d.name),
      ...(definitions[type]?.[kind] ?? []).map((d) => d.name),
    ]),
  ];
  const labelOf = (kind: "facts" | "lists", name: string) =>
    (view[kind] ?? []).find((d) => d.for === type && d.name === name)?.label ??
    definitions[type]?.[kind]?.find((d) => d.name === name)?.label ??
    name;
  return (
    <Modal title={BLOCK_LABEL[b.type]} onClose={onClose} wide={b.type === "fields"}>
      <div className="modal-body stack" style={{ gap: 16 }}>
        <label className="field">
          <span>Title (optional)</span>
          <input
            className="input"
            placeholder={BLOCK_LABEL[b.type]}
            value={b.title ?? ""}
            onChange={(e) => set({ title: e.target.value || undefined })}
          />
        </label>
        {(b.type === "facts" || b.type === "list") && (
          <label className="field">
            <span>About</span>
            <ChoiceSelect
              mono
              value={b.of && b.of !== "case.target" ? b.of.slice(5) : ""}
              options={entityTypes.filter((t) => t !== target)}
              placeholder={`The case's ${entityName(target).toLowerCase()}`}
              other="An object of another type…"
              onChange={(t) => set({ of: t ? `item.${t}` : undefined, facts: undefined, lists: undefined })}
            />
            <small>An object is an entity the case's triggers named, such as the device of a payment.</small>
          </label>
        )}
        {b.type === "fields" && (
          <div className="field">
            <span>Fields</span>
            <FieldPicker fields={b.fields} max={MAX_BLOCK_FIELDS} onChange={(fields) => set({ fields })} />
          </div>
        )}
        {(b.type === "images" || b.type === "documents") && (
          <>
            <div className="field">
              <span>Fields that hold an address</span>
              <FieldPicker fields={b.fields} max={MAX_MEDIA} formats={false} onChange={(fields) => set({ fields })} />
              <small>
                Such as subject.id_front_url or item.document.statement_url. Kairos reads an address only from the hosts
                approved in Settings › Workspace. A field can also hold the file itself, as a data address
                (data:image/jpeg;base64,…).
              </small>
            </div>
            <label className={`check ${b.sensitive !== false ? "on" : ""}`} style={{ alignSelf: "flex-start" }}>
              <input
                type="checkbox"
                checked={b.sensitive !== false}
                onChange={(e) => set({ sensitive: e.target.checked ? undefined : false })}
              />
              Hidden until a person opens them, and each opening recorded
            </label>
          </>
        )}
        {b.type === "checklist" && (
          <label className="field">
            <span>Points, one on each line</span>
            <textarea
              className="input"
              rows={6}
              value={(b.points ?? []).join("\n")}
              onChange={(e) => set({ points: e.target.value.split("\n").map((p) => p.trimStart()) })}
              onBlur={() => set({ points: (b.points ?? []).map((p) => p.trim()).filter(Boolean) })}
            />
            <small>At most {MAX_POINTS}, each at most 200 characters.</small>
          </label>
        )}
        {(b.type === "facts" || b.type === "list") && (
          <label className="field">
            <span>{b.type === "facts" ? "Facts" : "Lists"} (optional)</span>
            <MultiSelect
              label={b.type === "facts" ? "Facts" : "Lists"}
              value={(b.type === "facts" ? b.facts : b.lists) ?? []}
              options={names(b.type === "facts" ? "facts" : "lists").map((n) => ({
                value: n,
                label: labelOf(b.type === "facts" ? "facts" : "lists", n),
              }))}
              onChange={(chosen) =>
                set(
                  b.type === "facts"
                    ? { facts: chosen.length ? chosen : undefined }
                    : { lists: chosen.length ? chosen : undefined },
                )
              }
              placeholder={`Every ${b.type === "facts" ? "fact" : "list"} of the ${entityName(type).toLowerCase()}`}
            />
            <small>
              The page's own {b.type === "facts" ? "facts" : "lists"} for {entityName(type).toLowerCase()}, then those
              of its type. None chosen: the page's own, or the type's when the page has none.
            </small>
          </label>
        )}
        {b.type === "list" && (
          <label className="field">
            <span>Rows to a page</span>
            <input
              className="input"
              inputMode="numeric"
              style={{ width: 120 }}
              value={b.rows ?? 5}
              onChange={(e) => set({ rows: Number(e.target.value) || undefined })}
            />
          </label>
        )}
        {b.type === "text" && (
          <label className="field">
            <span>Text</span>
            <textarea
              className="input"
              rows={6}
              maxLength={2000}
              value={b.text ?? ""}
              onChange={(e) => set({ text: e.target.value })}
            />
          </label>
        )}
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSave(b)}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Region({
  region,
  view,
  target,
  labelOf,
  dragging,
  onDragging,
  onChange,
  onEdit,
  body,
}: {
  region: ViewRegion;
  view: CaseView;
  target: string;
  labelOf: LabelOf;
  dragging: string | null;
  onDragging: (id: string | null) => void;
  onChange: (blocks: ViewBlock[]) => void;
  onEdit: (id: string) => void;
  /** The block as a reviewer sees it, for the preview. Without it, the block's description. */
  body?: (block: ViewBlock) => ReactNode;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const blocks = view.blocks;
  const mine = blocks.filter((b) => b.region === region);
  const update = (id: string, patch: Partial<ViewBlock>) =>
    onChange(blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const dragOver = (event: React.DragEvent, over: ViewBlock | null) => {
    if (!dragging) return;
    event.preventDefault();
    if (over?.id === dragging) return;
    const moving = blocks.find((b) => b.id === dragging)!;
    const rest = blocks.filter((b) => b.id !== dragging);
    const at = over ? rest.findIndex((b) => b.id === over.id) : rest.length;
    const placed = { ...moving, region, ...(region === "side" ? { w: undefined } : {}) };
    const next = [...rest.slice(0, at), placed, ...rest.slice(at)];
    if (JSON.stringify(next) !== JSON.stringify(blocks)) onChange(next);
  };
  const startResize = (event: React.PointerEvent, block: ViewBlock) => {
    event.preventDefault();
    event.stopPropagation();
    const box = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const column = grid.current!.getBoundingClientRect().width / 12;
    const onMove = (move: PointerEvent) =>
      update(block.id, { w: Math.min(12, Math.max(MIN_WIDTH, Math.round((move.clientX - box.left) / column))) });
    const onUp = () => (
      window.removeEventListener("pointermove", onMove),
      window.removeEventListener("pointerup", onUp)
    );
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const add = (type: BlockType) => {
    const id = ruleId(
      type,
      blocks.map((b) => b.id),
    );
    const block: ViewBlock = {
      id,
      type,
      region,
      ...(type === "fields" ? { fields: [] } : {}),
      ...(type === "text" ? { text: "" } : {}),
      ...(type === "images" || type === "documents" ? { fields: [] } : {}),
      ...(type === "checklist" ? { points: [] } : {}),
    };
    onChange([...blocks, block]);
    if (!["evidence", "decisions", "timeline", "details", "objects", "activity"].includes(type)) onEdit(id);
  };
  return (
    <div className="view-region">
      <div
        ref={grid}
        className={region === "main" ? "view-main editing" : "stack view-side editing"}
        onDragOver={(e) => mine.length === 0 && dragOver(e, null)}
      >
        {mine.length === 0 && <div className="empty muted">Drag a block here, or add one below.</div>}
        {mine.map((b) => {
          const required = REQUIRED_BLOCKS.includes(b.type) && blocks.filter((x) => x.type === b.type).length === 1;
          return (
            <section
              key={b.id}
              className={`${body ? "vframe" : "card pad vtile"} ${dragging === b.id ? "dragging" : ""}`}
              style={region === "main" ? { gridColumn: `span ${b.w ?? 12}` } : undefined}
              draggable
              onDragStart={(e) => (
                e.dataTransfer.setData("text/plain", b.id),
                (e.dataTransfer.effectAllowed = "move"),
                onDragging(b.id)
              )}
              onDragOver={(e) => dragOver(e, b)}
              onDrop={(e) => e.preventDefault()}
              onDragEnd={() => onDragging(null)}
            >
              <div className={body ? "vframe-head" : "vtile-head"}>
                <span className="vtile-title">
                  {b.title ?? BLOCK_LABEL[b.type]}
                  {b.title && <span className="muted"> · {BLOCK_LABEL[b.type]}</span>}
                </span>
                <div className="tile-tools row">
                  {region === "main" && (
                    <>
                      <button
                        className="step"
                        title="Narrower"
                        disabled={(b.w ?? 12) <= MIN_WIDTH}
                        onClick={() => update(b.id, { w: (b.w ?? 12) - 1 })}
                      >
                        −
                      </button>
                      <span className="width" title="Columns of 12">
                        {b.w ?? 12}
                      </span>
                      <button
                        className="step"
                        title="Wider"
                        disabled={(b.w ?? 12) >= 12}
                        onClick={() => update(b.id, { w: (b.w ?? 12) + 1 })}
                      >
                        +
                      </button>
                    </>
                  )}
                  <button
                    className="step"
                    title={region === "main" ? "Move to the sidebar" : "Move to the main area"}
                    onClick={() => update(b.id, { region: region === "main" ? "side" : "main", w: undefined })}
                  >
                    {region === "main" ? "→" : "←"}
                  </button>
                  <button className="step" title="Change" onClick={() => onEdit(b.id)}>
                    ✎
                  </button>
                  <button
                    className="step"
                    title={required ? "Every page has it" : "Remove"}
                    disabled={required}
                    onClick={() => onChange(blocks.filter((x) => x.id !== b.id))}
                  >
                    ×
                  </button>
                </div>
              </div>
              {body ? (
                <div
                  className="vframe-body"
                  data-label={`${b.title ?? BLOCK_LABEL[b.type]}: nothing to show on this case`}
                >
                  {body(b)}
                </div>
              ) : (
                <p className="vtile-note">{blockSummary(b, target, labelOf)}</p>
              )}
              {region === "main" && (
                <div className="resize-handle" title="Drag to resize" onPointerDown={(e) => startResize(e, b)} />
              )}
            </section>
          );
        })}
      </div>
      <select
        className="input"
        style={{ marginTop: 10 }}
        aria-label={`Add a block to the ${region === "main" ? "main area" : "sidebar"}`}
        value=""
        disabled={blocks.length >= MAX_BLOCKS}
        onChange={(e) => e.target.value && add(e.target.value as BlockType)}
      >
        <option value="">{blocks.length >= MAX_BLOCKS ? `At most ${MAX_BLOCKS} blocks` : "+ Add a block"}</option>
        {BLOCK_TYPES.map((t) => (
          <option key={t} value={t}>
            {BLOCK_LABEL[t]}
          </option>
        ))}
      </select>
    </div>
  );
}

const SKETCH_LABEL: Record<BlockType, string> = {
  evidence: "Why",
  decisions: "Decisions",
  timeline: "Timeline",
  details: "Details",
  fields: "Fields",
  facts: "Facts",
  list: "Lists",
  objects: "Objects",
  activity: "Activity",
  text: "Notes",
  images: "Photos",
  documents: "Documents",
  checklist: "Checklist",
};

function LayoutSketch({ view }: { view: CaseView }) {
  const blocks = (region: ViewRegion) =>
    view.blocks
      .filter((b) => b.region === region)
      .map((b) => (
        <span
          key={b.id}
          className={`sk sk-${b.type}`}
          style={region === "main" ? { gridColumn: `span ${b.w ?? 12}` } : undefined}
        >
          {SKETCH_LABEL[b.type]}
        </span>
      ));
  return (
    <div className="sketch" aria-hidden>
      <div className={`sketch-header ${view.header?.length ? "" : "plain"}`} />
      <div className="sketch-body">
        <div className="sketch-main">{blocks("main")}</div>
        <div className="sketch-side">{blocks("side")}</div>
      </div>
    </div>
  );
}

/** A template's facts and lists are for "user": they become the case's own type. */
function fromTemplate(t: ViewTemplate, target: string): CaseView {
  const retype = <T extends { for: string }>(items: T[] | undefined) =>
    items?.map((d) => (d.for === "user" ? { ...d, for: target } : d));
  return { ...t.view, template: t.name, facts: retype(t.view.facts), lists: retype(t.view.lists) };
}

function OwnFactsAndLists({
  view,
  stored,
  types,
  onChange,
}: {
  view: CaseView;
  /** The view as saved: its facts and lists keep their names, as its blocks use them. */
  stored: CaseView | undefined;
  types: string[];
  onChange: (view: CaseView) => void;
}) {
  const [type, setType] = useState(types[0] ?? "");
  useEffect(() => {
    if (!types.includes(type) && types[0]) setType(types[0]);
  }, [types.join()]);
  const facts = (view.facts ?? []).filter((f) => f.for === type).map(({ for: _for, ...f }) => f as EntityFact);
  const lists = (view.lists ?? []).filter((l) => l.for === type).map(({ for: _for, ...l }) => l as EntityList);
  const keep = <T extends { for: string }>(items: T[] | undefined) => (items ?? []).filter((d) => d.for !== type);
  const setFacts = (next: EntityFact[]) => {
    const all = [...keep(view.facts), ...next.map((f) => ({ ...f, for: type }))];
    onChange({ ...view, facts: all.length ? all : undefined });
  };
  const setLists = (next: EntityList[]) => {
    const all = [...keep(view.lists), ...next.map((l) => ({ ...l, for: type }))];
    onChange({ ...view, lists: all.length ? all : undefined });
  };
  return (
    <>
      <Card title="This page's own facts and lists">
        <p className="section-note">
          For what this queue needs and others do not. A name here replaces the same name of the entity type, on this
          page only. The entity type's own facts and lists are in its definition.
        </p>
        <label className="field" style={{ maxWidth: 320 }}>
          <span>For the entity type</span>
          <ChoiceSelect mono value={type} options={types} other="Another type…" onChange={setType} />
        </label>
      </Card>
      {type && (
        <div className="split">
          <FactsEditor
            key={`f ${type}`}
            facts={facts}
            saved={(stored?.facts ?? []).filter((f) => f.for === type).map((f) => f.name)}
            onChange={setFacts}
          />
          <ListsEditor
            key={`l ${type}`}
            lists={lists}
            saved={(stored?.lists ?? []).filter((l) => l.for === type).map((l) => l.name)}
            onChange={setLists}
          />
        </div>
      )}
    </>
  );
}

type RegionProps = Omit<Parameters<typeof Region>[0], "region" | "body">;

function LivePreview({ queueId, ...regions }: RegionProps & { queueId: string }) {
  const { workspace, session } = useWorkspace();
  const { data: memberList } = useMembers(workspace.id);
  const actions = useActionNames();
  const definitions = useEntityDefinitions();
  const { data: list } = useApi(["layout-preview-cases", queueId], () =>
    queues.cases(queueId, { status: "", limit: 20, offset: 0 }),
  );
  const [chosen, setChosen] = useState<string | undefined>();
  const caseId = chosen ?? list?.cases[0]?.id;
  const { data: c } = useApi(["case", caseId], () => queues.case(caseId!), { enabled: !!caseId });
  const [draft, setDraft] = useState(regions.view);
  useEffect(() => {
    const timer = setTimeout(() => setDraft(regions.view), 400);
    return () => clearTimeout(timer);
  }, [JSON.stringify(regions.view)]);
  const valid = validateView(draft).length === 0;
  const { data: fresh } = useApi(
    ["layout-preview", caseId, JSON.stringify(draft)],
    () => queues.previewView(caseId!, draft),
    {
      enabled: !!caseId && valid,
    },
  );
  const [preview, setPreview] = useState<CaseViewData | null>(null);
  useEffect(() => {
    if (fresh) setPreview(fresh);
  }, [fresh]);

  if (list && list.cases.length === 0)
    return (
      <>
        <p className="note">This queue has no cases yet, so its blocks show as outlines.</p>
        <div className="split detail view-editor">
          <Region region="main" {...regions} />
          <Region region="side" {...regions} />
        </div>
      </>
    );
  if (!c || !preview) return <Loading />;
  const members = Object.fromEntries(
    (memberList?.members ?? []).flatMap((m) => [
      [m.id, m.name || m.email],
      [m.email, m.name || m.email],
    ]),
  );
  const ctx: CaseContext = {
    c,
    me: session.user.id,
    members,
    actions,
    definitions,
    busy: false,
    act: () => undefined,
    caseRows: new Set(c.items.map((i) => i.id)),
    draft,
  };
  const body = (b: ViewBlock) => <CaseBlock block={preview.blocks.find((r) => r.id === b.id) ?? b} ctx={ctx} />;
  return (
    <>
      <div className="preview-bar">
        <label className="row">
          <span className="muted">Preview with</span>
          <select className="input compact" value={caseId} onChange={(e) => setChosen(e.target.value)}>
            {(list?.cases ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.target_name ?? x.target.id} · {STATUS_LABEL[x.status]} · {stamp(x.created)}
              </option>
            ))}
          </select>
        </label>
        <small className="muted">Images stay closed, and nothing is recorded on the case.</small>
      </div>
      <div className="preview-title">
        <b>{c.target_name ?? c.target.id}</b>
        {preview.header.length > 0 && (
          <dl className="case-header-fields">
            {preview.header.map((v) => (
              <div key={v.field}>
                <dt>{v.label}</dt>
                <dd>
                  <ValueText v={v} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div className="split detail view-editor">
        <Region region="main" {...regions} body={body} />
        <Region region="side" {...regions} body={body} />
      </div>
    </>
  );
}

export function CaseViewEditorPage({ id }: { id: string }) {
  const { data: queue, error } = useApi(["queue", id], () => queues.get(id));
  const { data: templateList } = useApi(["case-view-templates"], () => queues.viewTemplates());
  const { data: actionList } = useActions();
  const { data: typeList } = useEntityTypeList();
  const definitions = useEntityDefinitions();
  const [view, setView] = useState<CaseView | null | undefined>(undefined);
  const [dragging, setDragging] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [mode, setMode] = useState<"preview" | "outline">("preview");
  const [picking, setPicking] = useState<"start" | "list" | null>(null);
  useEffect(() => {
    if (queue && view === undefined) {
      const stored = queue.display?.view ?? null;
      setView(stored);
      if (!stored) setPicking("start");
    }
  }, [queue]);
  if (error) return <Failure message={error.message} />;
  if (!queue || view === undefined) return <Loading />;

  const templates = templateList?.templates ?? [];
  const source = actionList?.actions.find((a) => queue.sources.actions?.includes(a.name));
  const target = source?.subject ?? "user";
  const entityTypes = [...new Set([target, ...(typeList?.types.map((t) => t.type) ?? [])])];
  const change = (next: CaseView | null) => (setView(next), setSaved(false));
  const problems = view ? validateView(view) : [];
  const editingBlock = view?.blocks.find((b) => b.id === editing);
  const labelOf: LabelOf = (kind, type, name) =>
    (view?.[kind] ?? []).find((d) => d.for === type && d.name === name)?.label ??
    definitions[type]?.[kind]?.find((d) => d.name === name)?.label ??
    name;

  const save = async () => {
    setSaving(true);
    setProblem(null);
    try {
      const { view: _old, ...display } = queue.display ?? {};
      await queues.save(queue.id, {
        ...definitionOf(queue),
        display: view ? { ...display, view } : display,
      });
      setSaved(true);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <InTopbar slot="trail-slot">
        <a href={href("queues", queue.id)}>{queue.name}</a>
        <span>›</span>
        <span className="here">Case Layout</span>
      </InTopbar>
      <header className="page-head with-actions">
        <div>
          <h1>Case Layout</h1>
          <p className="lede">
            What reviewers see when they open a case of {queue.name}: which blocks, and where.
            {view &&
              " Drag a block to move it, in its area or to the other one. Drag its right edge, or use − and +, to change its width."}
          </p>
        </div>
        <div className="row">
          {view && templates.length > 0 && (
            <button className="btn" onClick={() => setPicking("list")}>
              Use a template
            </button>
          )}
          <button className="btn" onClick={() => go("queues", queue.id, "edit")}>
            Back to the queue settings
          </button>
          <button
            className="btn primary"
            disabled={saving || problems.length > 0 || (!view && !queue.display?.view)}
            onClick={save}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>
      {problem && <div className="banner">{problem}</div>}
      {saved && <div className="banner ok">Saved. The cases of this queue show this layout now.</div>}
      {problems.length > 0 && <div className="banner">{problems.join(". ")}.</div>}

      {picking && (
        <TemplateModal
          key={picking}
          title="Case Layout"
          options={templates.map((t) => ({
            id: t.name,
            title: t.label,
            note: t.description,
            preview: <LayoutSketch view={t.view} />,
          }))}
          scratch={
            picking === "start"
              ? {
                  note: "The standard layout of every queue: why the case exists, its decisions, its history and details. Move, add and remove its blocks after.",
                  onPick: () => (change(structuredClone(DEFAULT_VIEW)), setPicking(null)),
                }
              : undefined
          }
          templatesNote="A layout made for one kind of review, such as payments or onboarding. Move, add and remove its blocks after."
          onPick={(name) => {
            const t = templates.find((x) => x.name === name)!;
            if (!view || confirm(`Replace this layout with the "${t.label}" template?`)) {
              change(fromTemplate(t, target));
              setPicking(null);
            }
          }}
          onClose={() => setPicking(null)}
        />
      )}

      {view === null ? (
        <Card title="No layout yet">
          <p className="section-note">
            The cases of {queue.name} show the standard layout now. Start from scratch or from a template: you can move,
            add and remove its blocks after. Nothing changes on the cases until you save.
          </p>
          <button className="btn primary" onClick={() => setPicking("start")}>
            Choose a layout
          </button>
        </Card>
      ) : (
        <div className="stack">
          <Card title="Header">
            <p className="section-note">Values under the case's title, such as the amount and the payee. At most 6.</p>
            <FieldPicker
              fields={view.header}
              max={MAX_HEADER_FIELDS}
              onChange={(header) => change({ ...view, header: header.length ? header : undefined })}
            />
          </Card>
          <div className="seg tight view-mode" role="tablist" aria-label="How to show the layout">
            <button className={mode === "preview" ? "on" : ""} onClick={() => setMode("preview")}>
              Preview
            </button>
            <button className={mode === "outline" ? "on" : ""} onClick={() => setMode("outline")}>
              Outline
            </button>
          </div>
          {mode === "preview" ? (
            <LivePreview
              queueId={queue.id}
              view={view}
              target={target}
              labelOf={labelOf}
              dragging={dragging}
              onDragging={setDragging}
              onChange={(blocks) => change({ ...view, blocks })}
              onEdit={setEditing}
            />
          ) : (
            <div className="split detail view-editor">
              <Region
                region="main"
                view={view}
                target={target}
                labelOf={labelOf}
                dragging={dragging}
                onDragging={setDragging}
                onChange={(blocks) => change({ ...view, blocks })}
                onEdit={setEditing}
              />
              <Region
                region="side"
                view={view}
                target={target}
                labelOf={labelOf}
                dragging={dragging}
                onDragging={setDragging}
                onChange={(blocks) => change({ ...view, blocks })}
                onEdit={setEditing}
              />
            </div>
          )}
          <OwnFactsAndLists
            view={view}
            stored={queue.display?.view}
            types={[
              ...new Set([target, ...view.blocks.filter((b) => b.of?.startsWith("item.")).map((b) => b.of!.slice(5))]),
            ]}
            onChange={change}
          />
          <div className="row">
            <button
              className="btn ghost"
              onClick={() => confirm("Show the standard layout on this queue's cases again?") && change(null)}
            >
              Go back to the standard layout
            </button>
          </div>
        </div>
      )}
      {editingBlock && view && (
        <BlockModal
          key={editingBlock.id}
          block={editingBlock}
          view={view}
          target={target}
          definitions={definitions}
          entityTypes={entityTypes}
          onSave={(b) => (
            change({ ...view, blocks: view.blocks.map((x) => (x.id === b.id ? b : x)) }),
            setEditing(null)
          )}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
