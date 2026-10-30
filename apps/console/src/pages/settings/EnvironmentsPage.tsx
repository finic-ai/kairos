import { useState, FormEvent } from "react";
import { environments } from "../../api/index";
import type { CopyCategory, Environment, EnvironmentCopyOptions, Workspace } from "../../types/interfaces";
import { CopySelectionModal } from "../../components/environments/CopySelectionModal";
import { selectionSummary } from "../../lib/environments";
import { Copy } from "../../components/ui/Copy";
import { Group, Row } from "../../components/ui/Group";
import { Modal } from "../../components/ui/Modal";

const DEFAULT_COPY: EnvironmentCopyOptions = {
  entities: false,
  actions: true,
  events: false,
  dashboards: false,
  queues: false,
  decisions: false,
  models: false,
};
const COPY_OPTIONS: { id: keyof EnvironmentCopyOptions; title: string; note: string }[] = [
  { id: "entities", title: "Entities", note: "Definitions, profiles, properties, and labels." },
  { id: "actions", title: "Actions", note: "Action definitions and policies. Automatic decisions start off." },
  { id: "events", title: "Events", note: "Event history, including entity, session, and record links." },
  {
    id: "dashboards",
    title: "Dashboards",
    note: "Layouts you can access. Other people's private dashboards stay private.",
  },
  {
    id: "queues",
    title: "Queues",
    note: "Their sources, rules, grouping and columns, not their cases. Other people's private queues stay private.",
  },
  {
    id: "decisions",
    title: "Decisions",
    note: "History, context, and resolutions, with the related events and action versions.",
  },
  {
    id: "models",
    title: "Models",
    note: "Scoring models with all their versions, so that a step's model@2 finds the same file. Archived models are not copied.",
  },
];

export function EnvironmentsPage({
  workspace,
  current,
  onChange,
  onChoose,
}: {
  workspace: Workspace;
  current: Environment;
  onChange: () => void;
  onChoose: (id: string) => void;
}) {
  const admin = workspace.role !== "member";
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Environment | null>(null);
  const [deleting, setDeleting] = useState<Environment | null>(null);
  const [name, setName] = useState("");
  const [source, setSource] = useState(current.id);
  const [selectedCopy, setSelectedCopy] = useState<EnvironmentCopyOptions>(DEFAULT_COPY);
  const [picking, setPicking] = useState<CopyCategory | null>(null);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (!busy) {
      setCreating(false);
      setEditing(null);
      setDeleting(null);
      setPicking(null);
      setError(null);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing) await environments.rename(workspace.id, editing.id, name);
      else
        await environments.create(workspace.id, { name, ...(source ? { copy_from: source, copy: selectedCopy } : {}) });
      setCreating(false);
      setEditing(null);
      onChange();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (event: FormEvent) => {
    event.preventDefault();
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await environments.remove(workspace.id, deleting.id, confirm);
      setDeleting(null);
      onChange();
      if (current.id === deleting.id) onChoose(workspace.environments.find((e) => e.kind === "production")!.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Environments</h1>
      <Group
        title="Production and sandboxes"
        note="One Production environment and as many sandboxes as you need. Each has its own data, actions, API keys, and webhooks. Workspace members can access every environment."
        action={
          admin && (
            <button
              className="btn primary"
              onClick={() => {
                setName("");
                setSource(current.id);
                setSelectedCopy(DEFAULT_COPY);
                setError(null);
                setCreating(true);
              }}
            >
              New sandbox
            </button>
          )
        }
      >
        <div className="card rows">
          {workspace.environments.map((environment) => (
            <Row
              key={environment.id}
              title={environment.name}
              note={`${environment.kind === "production" ? "Production" : "Sandbox"}${environment.id === current.id ? " · Selected" : ""}`}
            >
              {environment.id !== current.id && (
                <button className="btn" onClick={() => onChoose(environment.id)}>
                  Switch
                </button>
              )}
              {admin && environment.kind === "sandbox" && (
                <>
                  <button
                    className="btn"
                    onClick={() => {
                      setEditing(environment);
                      setName(environment.name);
                      setError(null);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => {
                      setDeleting(environment);
                      setConfirm("");
                      setError(null);
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
            </Row>
          ))}
        </div>
      </Group>
      <Group title="Selected environment" note="API keys created here belong to this environment.">
        <div className="card rows">
          <Row title={current.name} note="Environment ID">
            <Copy value={current.id} />
          </Row>
        </div>
      </Group>
      {(creating || editing) && !picking && (
        <Modal title={editing ? "Rename sandbox" : "New sandbox"} onClose={close} wide={!editing}>
          <form className="modal-body" onSubmit={save}>
            {error && <div className="banner">{error}</div>}
            <label className="field">
              <span>Name</span>
              <input
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
                autoFocus
                disabled={busy}
                placeholder="Staging, development, or an experiment"
              />
            </label>
            {!editing && (
              <>
                <label className="field">
                  <span>Starting point</span>
                  <select
                    className="input"
                    value={source}
                    onChange={(e) => {
                      setSource(e.target.value);
                      setSelectedCopy(DEFAULT_COPY);
                    }}
                    disabled={busy}
                  >
                    <option value="">Start empty</option>
                    {workspace.environments.map((e) => (
                      <option key={e.id} value={e.id}>
                        Copy from {e.name}
                      </option>
                    ))}
                  </select>
                </label>
                {source && (
                  <fieldset className="environment-copy-options" disabled={busy}>
                    <legend>Choose what to copy</legend>
                    {COPY_OPTIONS.map((option) => (
                      <div className="environment-copy-category" key={option.id}>
                        <label className="environment-copy-option">
                          <input
                            type="checkbox"
                            checked={!!selectedCopy[option.id]}
                            onChange={(e) =>
                              setSelectedCopy((previous) => ({ ...previous, [option.id]: e.target.checked }))
                            }
                          />
                          <span>
                            <b>{option.title}</b>
                            <small>{option.note}</small>
                            <small className="copy-selection-summary">
                              {selectionSummary(selectedCopy[option.id], option.id)}
                            </small>
                          </span>
                        </label>
                        <button
                          type="button"
                          className="btn"
                          aria-label={`Choose ${option.title.toLowerCase()} to copy`}
                          onClick={() => setPicking(option.id)}
                        >
                          Choose items
                        </button>
                      </div>
                    ))}
                  </fieldset>
                )}
                {source && !!selectedCopy.decisions && (
                  <p className="note">
                    The triggering events and action versions required by your selected decisions are included
                    automatically. Other events and actions follow your selections above.
                  </p>
                )}
                <p className="note">
                  {source ? "Copies are independent. " : "Starts empty. "}Create new API keys and webhooks in this
                  sandbox.
                </p>
                {busy && source && (
                  <p className="note" role="status">
                    Copying your selection. Large histories can take a little while.
                  </p>
                )}
              </>
            )}
            <div className="modal-foot">
              <button type="button" className="btn" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy || !name.trim()}>
                {busy ? (source && !editing ? "Copying…" : "Saving…") : editing ? "Save" : "Create sandbox"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {creating && picking && source && (
        <CopySelectionModal
          key={`${source}:${picking}`}
          workspace={workspace.id}
          source={source}
          category={picking}
          value={selectedCopy[picking]}
          onApply={(value) => {
            setSelectedCopy((previous) => ({ ...previous, [picking]: value }));
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
      {deleting && (
        <Modal title={`Delete ${deleting.name}`} onClose={close}>
          <form className="modal-body" onSubmit={remove}>
            {error && <div className="banner">{error}</div>}
            <p>This permanently deletes this sandbox, its data, API keys, and webhooks.</p>
            <label className="field">
              <span>Type {deleting.name} to confirm</span>
              <input
                className="input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoFocus
                disabled={busy}
              />
            </label>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button className="btn danger" disabled={busy || confirm.trim() !== deleting.name}>
                {busy ? "Deleting…" : "Delete sandbox"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
