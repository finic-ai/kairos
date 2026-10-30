import { FormEvent, useState } from "react";
import { workspaces } from "../../api/index";
import type { Workspace } from "../../types/interfaces";
import { Modal } from "../ui/Modal";

export function DeleteWorkspace({
  workspace,
  onClose,
  onDeleted,
}: {
  workspace: Workspace;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    workspaces.remove(workspace.id, value).then(onDeleted, (e: Error) => setError(e.message));
  };
  return (
    <Modal title="Delete workspace" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <p>
          <b>{workspace.name}</b> and all of its events, entities, actions and decisions will be permanently deleted for
          every member. API keys stop working immediately.
        </p>
        <p>This can't be undone.</p>
        <label className="field">
          <span>
            Type <b>{workspace.name}</b> to confirm
          </span>
          <input
            className="input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            required
            autoFocus
          />
        </label>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" disabled={value.trim() !== workspace.name}>
            Delete workspace
          </button>
        </div>
      </form>
    </Modal>
  );
}
