import { useState, type FormEvent, type ReactNode } from "react";
import { workspaces } from "../../api/index";
import type { Role, Workspace } from "../../types/interfaces";
import { Copy } from "../../components/ui/Copy";
import { AuthLayout } from "../../layouts/AuthLayout";
import { ROLE_NOTE, ROLES } from "../../lib/roles";
import { href } from "../../lib/route";

/** The server makes the slug the same way, and adds -2, -3… when another workspace has it. */
const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workspace";

export function NewWorkspacePage({
  lede = "A workspace holds your team's actions, decisions and cases.",
  cancel,
  onDone,
}: {
  lede?: ReactNode;
  cancel: { label: string; onClick: () => void };
  onDone: (id: string) => void;
}) {
  const [created, setCreated] = useState<Workspace | null>(null);
  return created ? (
    <InviteStep workspace={created} onDone={() => onDone(created.id)} />
  ) : (
    <CreateStep lede={lede} cancel={cancel} onCreated={setCreated} />
  );
}

function CreateStep({
  lede,
  cancel,
  onCreated,
}: {
  lede: ReactNode;
  cancel: { label: string; onClick: () => void };
  onCreated: (workspace: Workspace) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    workspaces.create(name).then(onCreated, (e: Error) => (setError(e.message), setBusy(false)));
  };
  return (
    <AuthLayout title="Create a workspace" lede={lede}>
      {error && <div className="banner">{error}</div>}
      <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            placeholder="Acme"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            autoFocus
          />
        </label>
        <div className="field">
          <span>Slug</span>
          <div className={`fixed-value mono ${name.trim() ? "" : "muted"}`}>{slugOf(name)}</div>
          <small>Made from the name. If another workspace has it, Kairos adds a number.</small>
        </div>
        <button className="btn primary block-w" disabled={busy || !name.trim()}>
          {busy ? "Creating…" : "Create workspace"}
        </button>
        <button type="button" className="btn block-w" onClick={cancel.onClick}>
          {cancel.label}
        </button>
      </form>
    </AuthLayout>
  );
}

function InviteStep({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [links, setLinks] = useState<{ email: string; role: Role; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    workspaces
      .invite(workspace.id, email, role)
      .then(
        ({ invite, token }) => (
          setLinks([
            ...links.filter((l) => l.email !== invite.email),
            { email: invite.email, role: invite.role, url: `${window.location.origin}/${href("invite", token)}` },
          ]),
          setEmail("")
        ),
        (e: Error) => setError(e.message),
      )
      .finally(() => setBusy(false));
  };
  return (
    <AuthLayout
      title="Invite your team"
      lede={
        <>
          Invite the people who work with you in <b>{workspace.name}</b>. You can also do this later, in Settings ›
          Members.
        </>
      }
    >
      {error && <div className="banner">{error}</div>}
      <form className="stack" style={{ gap: 14 }} onSubmit={submit}>
        <label className="field">
          <span>Email</span>
          <input
            className="input"
            type="email"
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="field">
          <span>Role</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <small>{ROLE_NOTE[role]}</small>
        </label>
        <button className="btn block-w" disabled={busy}>
          {busy ? "Creating…" : "Create invite link"}
        </button>
      </form>
      {links.length > 0 && (
        <div className="stack invite-links">
          <p className="note">
            Share each link with its person. A link works only for its email, and expires in 7 days. Kairos does not
            send it for you.
          </p>
          {links.map((l) => (
            <div key={l.email} className="field">
              <span>
                {l.email} <span className="muted">· {l.role}</span>
              </span>
              <Copy value={l.url} />
            </div>
          ))}
        </div>
      )}
      <div className="auth-actions">
        <button type="button" className={`btn block-w ${links.length ? "primary" : "ghost"}`} onClick={onDone}>
          {links.length ? "Continue" : "Skip for now"}
        </button>
      </div>
    </AuthLayout>
  );
}
