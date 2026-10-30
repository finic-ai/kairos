import { FormEvent, useState } from "react";
import { auth } from "../../api/index";
import type { Session } from "../../types/interfaces";
import { Modal } from "../ui/Modal";

export function DeleteAccount({
  session,
  onClose,
  onDeleted,
}: {
  session: Session;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { user } = session;
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    auth
      .deleteAccount(user.has_password ? { password: value } : { confirm: value })
      .then(onDeleted, (e: Error) => setError(e.message));
  };
  return (
    <Modal title="Delete account" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <p>
          Your account <b>{user.email}</b> will be permanently deleted. Workspaces where you're the only member are
          deleted too, along with their data.
        </p>
        <p>This can't be undone.</p>
        <label className="field">
          <span>{user.has_password ? "Enter your password to confirm" : `Type ${user.email} to confirm`}</span>
          <input
            className="input"
            type={user.has_password ? "password" : "text"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete={user.has_password ? "current-password" : "off"}
            required
            autoFocus
          />
        </label>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn danger" disabled={!value}>
            Delete account
          </button>
        </div>
      </form>
    </Modal>
  );
}
