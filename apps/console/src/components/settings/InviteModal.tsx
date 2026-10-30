import { FormEvent, useState } from "react";
import { workspaces } from "../../api/index";
import type { Role } from "../../types/interfaces";
import type { Workspace } from "../../types/interfaces";
import { Copy } from "../ui/Copy";
import { Modal } from "../ui/Modal";
import { ROLE_NOTE, ROLES } from "../../lib/roles";
import { href } from "../../lib/route";

export function InviteModal({
  workspace,
  onClose,
  onInvited,
}: {
  workspace: Workspace;
  onClose: () => void;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    workspaces.invite(workspace.id, email, role).then(
      ({ invite, token }) => (
        setLink({ email: invite.email, url: `${window.location.origin}/${href("invite", token)}` }),
        onInvited()
      ),
      (e: Error) => setError(e.message),
    );
  };
  if (link)
    return (
      <Modal title="Invite link" onClose={onClose}>
        <div className="modal-body">
          <p>
            Share this link with <b>{link.email}</b>. It expires in 7 days and only works for that email. You won't see
            it again.
          </p>
          <Copy value={link.url} />
          <div className="modal-foot">
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  return (
    <Modal title="Invite member" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <label className="field">
          <span>Email</span>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>Role</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.filter((r) => r !== "owner" || workspace.role === "owner").map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <small>{ROLE_NOTE[role]}</small>
        </label>
        <p className="note">You'll get a link to share. Kairos doesn't send the invite for you.</p>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Create invite</button>
        </div>
      </form>
    </Modal>
  );
}
