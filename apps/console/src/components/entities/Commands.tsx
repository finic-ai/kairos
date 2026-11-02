import {
  COMMAND_INPUT_TYPES,
  COMMAND_VISIBILITY,
  ENTITY_COLORS,
  ENTITY_ICONS,
  MAX_COMMAND_INPUTS,
  MAX_COMMANDS,
  validateCommands,
  type CommandInput,
  type CommandVisibility,
  type EntityColor,
  type EntityCommand,
  type EntityIcon as IconName,
} from "@kairos/core";
import { useRef, useState, type FormEvent } from "react";
import { api } from "../../api/index";
import { entityName } from "../../lib/format";
import type { EntityRef } from "../../types/interfaces";
import { Card } from "../ui/Card";
import { Modal } from "../ui/Modal";
import { EntityIcon } from "./EntityIcon";

const VISIBILITY_LABEL: Record<CommandVisibility, string> = {
  all: "Case and entity",
  case: "Case only",
  entity: "Entity only",
};

const blank = (): EntityCommand => ({ name: "", key: "", label: "", color: "blue" });

/** "Block user" becomes block_user. A trailing underscore stays until save. */
function toCommandKey(value: string, final = false): string {
  let key = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z_]+/, "");
  if (final) key = key.replace(/^_+|_+$/g, "");
  return key.slice(0, 64);
}

function clean(command: EntityCommand): EntityCommand {
  const description = command.description?.trim();
  const name = command.name.trim();
  return {
    name,
    key: toCommandKey(command.key, true) || toCommandKey(name, true),
    ...(description ? { description } : {}),
    label: command.label.trim(),
    color: command.color,
    ...(command.icon ? { icon: command.icon } : {}),
    ...(command.visibility && command.visibility !== "all" ? { visibility: command.visibility } : {}),
    ...(command.inputs?.length ? { inputs: command.inputs.map(cleanInput) } : {}),
  };
}

function fieldProblem(text: string): string {
  return text
    .replace(/^key must match.*$/, "Key needs a letter. Use letters, digits and underscores.")
    .replace(/^key "(.*)" is already used$/, 'Key "$1" is already used')
    .replace(/^name must be text/, "Name must be text")
    .replace(/^description must be text/, "Description must be text")
    .replace(/^label must be text/, "Button label must be text");
}

function cleanInput(input: CommandInput): CommandInput {
  return {
    name: input.name.trim(),
    label: input.label.trim(),
    type: input.type,
    ...(input.required ? { required: true } : {}),
    ...(input.type === "choice" ? { options: input.options ?? [] } : {}),
  };
}

export function CommandsEditor({
  commands,
  onChange,
}: {
  commands: EntityCommand[];
  onChange: (commands: EntityCommand[]) => void;
}) {
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [draft, setDraft] = useState<EntityCommand>(blank());
  const [problem, setProblem] = useState<string | null>(null);
  const open = (index: number) => {
    setDraft(commands[index]!);
    setProblem(null);
    setEditing(index);
  };
  const add = () => {
    setDraft(blank());
    setProblem(null);
    setEditing("new");
  };
  const close = () => setEditing(null);
  const save = (event: FormEvent) => {
    event.preventDefault();
    const next = clean(draft);
    const at = editing === "new" ? commands.length : editing;
    const list = editing === "new" ? [...commands, next] : commands.map((command, i) => (i === at ? next : command));
    if (!next.name) {
      setProblem("Name is required.");
      return;
    }
    const problems = validateCommands(list).filter((item) => item.startsWith(`commands[${at}]`));
    if (problems.length) {
      setProblem(fieldProblem(problems[0]!.replace(`commands[${at}].`, "").replace(`commands[${at}] `, "")));
      return;
    }
    onChange(list);
    close();
  };
  const remove = () => {
    if (editing === "new" || editing === null) return;
    onChange(commands.filter((_, i) => i !== editing));
    close();
  };
  return (
    <Card title="Commands">
      <p className="note">
        A button on this entity. A click sends a webhook, and your system does the work, such as block a user or reset a
        password.
      </p>
      {commands.length > 0 && (
        <table className="command-list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Preview</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {commands.map((command, index) => (
              <tr key={index}>
                <td>{command.name.trim() || "—"}</td>
                <td className="mono">{command.key.trim() || "—"}</td>
                <td>
                  <span className={`btn cmd-btn ent-${command.color || "blue"}`}>
                    {command.icon && <EntityIcon icon={command.icon} color={command.color} size="sm" />}
                    {command.label.trim() || "Button"}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Edit ${command.name.trim() || command.key.trim() || "command"}`}
                    onClick={() => open(index)}
                  >
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                      <path d="M13.6 3.6a1.9 1.9 0 0 1 2.8 2.8L7.5 15.3 4 16l.7-3.5z" />
                      <path d="m12 5.2 2.8 2.8" />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {commands.length < MAX_COMMANDS && (
        <button type="button" className="btn command-add" onClick={add}>
          Add a command
        </button>
      )}
      {editing !== null && (
        <Modal title={editing === "new" ? "Add a command" : "Edit command"} onClose={close} className="command-editor">
          <form className="modal-body" onSubmit={save}>
            <CommandFields
              key={String(editing)}
              command={draft}
              followKey={editing === "new"}
              onChange={(patch) => setDraft({ ...draft, ...patch })}
            />
            {problem && <p className="note">{problem}</p>}
            <div className="modal-foot">
              {editing !== "new" && (
                <button type="button" className="btn command-remove" onClick={remove}>
                  Remove
                </button>
              )}
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn primary">
                Save
              </button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}

function CommandFields({
  command,
  followKey,
  onChange,
}: {
  command: EntityCommand;
  followKey: boolean;
  onChange: (patch: Partial<EntityCommand>) => void;
}) {
  const [follow, setFollow] = useState(followKey);
  const inputs = command.inputs ?? [];
  const setInput = (index: number, patch: Partial<CommandInput>) =>
    onChange({ inputs: inputs.map((input, i) => (i === index ? { ...input, ...patch } : input)) });
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="command-fields">
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={command.name}
            placeholder="Block user"
            onChange={(e) => {
              const name = e.target.value;
              onChange(follow ? { name, key: toCommandKey(name) } : { name });
            }}
          />
        </label>
        <label className="field">
          <span>Key</span>
          <input
            className="input mono"
            value={command.key}
            placeholder="block_user"
            onChange={(e) => {
              const key = toCommandKey(e.target.value);
              setFollow(key === "");
              onChange({ key });
            }}
          />
        </label>
      </div>
      <small className="note">The key in the webhook. The name fills it. You can change it.</small>
      <label className="field">
        <span>Description</span>
        <textarea
          className="input"
          rows={3}
          value={command.description ?? ""}
          placeholder="What this command asks your system to do"
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </label>
      <div className="stack" style={{ gap: 8 }}>
        <span className="command-section">Button</span>
        <div className="command-fields three">
          <label className="field">
            <span>Label</span>
            <input
              className="input"
              value={command.label}
              placeholder="Block user"
              onChange={(e) => onChange({ label: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Colour</span>
            <select
              className="input"
              value={command.color}
              onChange={(e) => onChange({ color: e.target.value as EntityColor })}
            >
              {ENTITY_COLORS.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Icon</span>
            <select
              className="input"
              value={command.icon ?? ""}
              onChange={(e) => onChange({ icon: (e.target.value || undefined) as IconName | undefined })}
            >
              <option value="">None</option>
              {ENTITY_ICONS.map((icon) => (
                <option key={icon} value={icon}>
                  {icon}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <label className="field">
        <span>Visibility</span>
        <select
          className="input"
          value={command.visibility ?? "all"}
          onChange={(e) => onChange({ visibility: e.target.value as CommandVisibility })}
        >
          {COMMAND_VISIBILITY.map((value) => (
            <option key={value} value={value}>
              {VISIBILITY_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <div className="stack" style={{ gap: 8 }}>
        <span className="command-section">Inputs</span>
        {inputs.map((input, index) => (
          <div key={index} className="row wrap" style={{ gap: 8 }}>
            <input
              className="input mono"
              style={{ width: 140 }}
              value={input.name}
              placeholder="reason"
              aria-label="Input name"
              onChange={(e) => setInput(index, { name: e.target.value })}
            />
            <input
              className="input"
              style={{ width: 160 }}
              value={input.label}
              placeholder="Reason"
              aria-label="Input label"
              onChange={(e) => setInput(index, { label: e.target.value })}
            />
            <select
              className="input"
              style={{ width: 120 }}
              value={input.type}
              aria-label="Input type"
              onChange={(e) => setInput(index, { type: e.target.value as CommandInput["type"] })}
            >
              {COMMAND_INPUT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <label className="check">
              <input
                type="checkbox"
                checked={input.required === true}
                onChange={(e) => setInput(index, { required: e.target.checked })}
              />
              Required
            </label>
            {input.type === "choice" && (
              <input
                className="input"
                style={{ minWidth: 180, flex: 1 }}
                value={(input.options ?? []).join(", ")}
                placeholder="fraud, takeover"
                aria-label="Choices"
                onChange={(e) =>
                  setInput(index, {
                    options: e.target.value
                      .split(",")
                      .map((part) => part.trim())
                      .filter(Boolean),
                  })
                }
              />
            )}
            <button
              type="button"
              className="btn"
              onClick={() => onChange({ inputs: inputs.filter((_, i) => i !== index) })}
            >
              Remove
            </button>
          </div>
        ))}
        {inputs.length < MAX_COMMAND_INPUTS && (
          <button
            type="button"
            className="btn"
            onClick={() => onChange({ inputs: [...inputs, { name: "", label: "", type: "text" }] })}
          >
            Add an input
          </button>
        )}
      </div>
    </div>
  );
}

export function visibleCommands(commands: EntityCommand[] | undefined, page: "case" | "entity") {
  return (commands ?? []).filter((command) => {
    const visibility = command.visibility ?? "all";
    return visibility === "all" || visibility === page;
  });
}

export interface CommandGroup {
  entity: EntityRef;
  name?: string | null;
  commands: EntityCommand[] | undefined;
  caseId?: string;
  onDone?: () => void;
}

export function CommandCard({ page, groups }: { page: "case" | "entity"; groups: CommandGroup[] }) {
  const live = groups.filter((group) => visibleCommands(group.commands, page).length > 0);
  if (live.length === 0) return null;
  return (
    <Card title="Commands" className="o-commands">
      {live.map((group) => (
        <div key={`${group.entity.type} ${group.entity.id}`} className="command-group">
          {live.length > 1 && (
            <div className="command-who">
              <span className="chip">{entityName(group.entity.type)}</span>
              {group.name ? (
                <span>
                  {group.name} <span className="mono muted">{group.entity.id}</span>
                </span>
              ) : (
                <span className="mono">{group.entity.id}</span>
              )}
            </div>
          )}
          <CommandButtons
            entity={group.entity}
            commands={group.commands}
            page={page}
            caseId={group.caseId}
            onDone={group.onDone}
          />
        </div>
      ))}
    </Card>
  );
}

export function CommandButtons({
  entity,
  commands,
  page,
  caseId,
  onDone,
}: {
  entity: EntityRef;
  commands: EntityCommand[] | undefined;
  page: "case" | "entity";
  caseId?: string;
  onDone?: () => void;
}) {
  const shown = visibleCommands(commands, page);
  const [open, setOpen] = useState<EntityCommand | null>(null);
  if (shown.length === 0) return null;
  return (
    <div className="command-actions">
      <div className="row wrap">
        {shown.map((command) => (
          <button
            key={command.key}
            type="button"
            className={`btn cmd-btn ent-${command.color}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              // The dialog mounts after this click, so the click cannot land on its confirm button.
              window.setTimeout(() => setOpen(command), 0);
            }}
          >
            {command.icon && <EntityIcon icon={command.icon} color={command.color} size="sm" />}
            {command.label}
          </button>
        ))}
      </div>
      {open && (
        <IssueDialog
          command={open}
          entity={entity}
          caseId={caseId}
          onClose={() => setOpen(null)}
          onDone={() => (setOpen(null), onDone?.())}
        />
      )}
    </div>
  );
}

function IssueDialog({
  command,
  entity,
  caseId,
  onClose,
  onDone,
}: {
  command: EntityCommand;
  entity: EntityRef;
  caseId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const inputs = command.inputs ?? [];
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);
  const set = (name: string, value: unknown) => setValues((current) => ({ ...current, [name]: value }));
  const issue = async (event: FormEvent) => {
    event.preventDefault();
    if (busy.current) return;
    const missing = inputs.find(
      (input) =>
        input.required && input.type !== "boolean" && (values[input.name] === undefined || values[input.name] === ""),
    );
    if (missing) {
      setProblem(`${missing.label} is required`);
      return;
    }
    busy.current = true;
    setSaving(true);
    setProblem(null);
    const body: Record<string, unknown> = {};
    for (const input of inputs) {
      if (input.type === "boolean") body[input.name] = values[input.name] === true;
      else if (values[input.name] !== undefined && values[input.name] !== "") body[input.name] = values[input.name];
    }
    try {
      await api.issueCommand(entity, command.key, { inputs: body, ...(caseId ? { case_id: caseId } : {}) });
      onDone();
    } catch (error) {
      busy.current = false;
      setProblem((error as Error).message);
      setSaving(false);
    }
  };
  return (
    <Modal title={command.label} onClose={onClose}>
      <form className="modal-body" onSubmit={issue}>
        {command.description && <p className="note" style={{ margin: "5px 0 0" }}>{command.description}</p>}
        <p className="note" style={{ margin: "5px 0 0" }}>
         This sends a webhook command for {entity.type} <span className="mono">{entity.id}</span> to your system.
        </p>
        {inputs.map((input) => (
          <InputField
            key={input.name}
            input={input}
            value={values[input.name]}
            onChange={(value) => set(input.name, value)}
          />
        ))}
        {problem && <p className="note">{problem}</p>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className={`btn cmd-btn ent-${command.color}`} disabled={saving}>
            {saving ? "Sending…" : command.label}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function InputField({
  input,
  value,
  onChange,
}: {
  input: CommandInput;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = input.required ? `${input.label} *` : input.label;
  if (input.type === "boolean")
    return (
      <label className="check">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  if (input.type === "choice")
    return (
      <label className="field">
        <span>{label}</span>
        <select
          className="input"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Choose…</option>
          {(input.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        type={input.type === "number" ? "number" : "text"}
        value={value === undefined ? "" : String(value)}
        onChange={(e) =>
          onChange(
            input.type === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value,
          )
        }
      />
    </label>
  );
}

export { clean as cleanCommand };
