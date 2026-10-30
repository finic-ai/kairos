import { FormEvent, useEffect, useState } from "react";
import { workspaces } from "../../api/index";
import { DeleteWorkspace } from "../../components/settings/DeleteWorkspace";
import { RetentionWarning } from "../../components/settings/RetentionWarning";
import { Banner, type Message } from "../../components/ui/Banner";
import { Copy } from "../../components/ui/Copy";
import { Group, Row } from "../../components/ui/Group";
import { useApi } from "../../hooks/useApi";
import { dayOf } from "../../lib/format";
import { go } from "../../lib/route";
import type { SettingsPageProps } from "./types";

function MediaHosts({
  workspaceId,
  manage,
  onMessage,
}: {
  workspaceId: string;
  manage: boolean;
  onMessage: (m: Message) => void;
}) {
  const { data, refetch } = useApi(["media-hosts", workspaceId], () => workspaces.mediaHosts(workspaceId));
  const [text, setText] = useState("");
  useEffect(() => setText((data?.hosts ?? []).join("\n")), [data]);
  const hosts = text
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean);
  const changed = hosts.join("\n") !== (data?.hosts ?? []).join("\n");
  const save = (event: FormEvent) => {
    event.preventDefault();
    workspaces.setMediaHosts(workspaceId, hosts).then(
      () => (onMessage({ ok: true, text: "Image and document hosts saved." }), refetch()),
      (e: Error) => onMessage({ ok: false, text: e.message }),
    );
  };
  return (
    <form className="card rows" onSubmit={save}>
      <Row
        title="Image and document hosts"
        note={
          <>
            Case layouts show images and documents only from these hosts, read through Kairos, so the browser never
            loads your storage. One on each line, such as <span className="mono">files.example.com</span>, or{" "}
            <span className="mono">*.example.com</span> for every subdomain. At most 20.
            {!manage && " Only owners and admins can change this."}
          </>
        }
      >
        <textarea
          className="input mono"
          rows={4}
          placeholder="files.example.com"
          value={text}
          disabled={!manage}
          onChange={(e) => setText(e.target.value)}
        />
        {manage && (
          <button className="btn" disabled={!changed}>
            Save
          </button>
        )}
      </Row>
    </form>
  );
}

const PERIODS = [30, 90, 180, 365, 730];
const RETENTION_DOCS = "/docs/platform/workspaces#data-retention";
const describe = (days: number | null) =>
  days === null ? "forever" : days % 365 === 0 ? `${days / 365} year${days === 365 ? "" : "s"}` : `${days} days`;

/** How long the workspace keeps its history, in every environment. */
function DataRetention({
  workspaceId,
  manage,
  onMessage,
}: {
  workspaceId: string;
  manage: boolean;
  onMessage: (m: Message) => void;
}) {
  const { data, refetch } = useApi(["data-retention", workspaceId], () => workspaces.dataRetention(workspaceId));
  const saved = data?.retention_days ?? null;
  const locked = !manage || !data;
  const [choice, setChoice] = useState("forever");
  const [custom, setCustom] = useState("");
  useEffect(() => {
    if (saved === null) setChoice("forever");
    else if (PERIODS.includes(saved)) setChoice(String(saved));
    else (setChoice("custom"), setCustom(String(saved)));
  }, [saved]);
  const [warning, setWarning] = useState(false);
  const days = choice === "forever" ? null : Number(choice === "custom" ? custom : choice);
  const valid = days === null || (Number.isInteger(days) && days >= 7 && days <= 3650);
  const shorter = days !== null && (saved === null || days < saved);
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (shorter) setWarning(true);
    else store();
  };
  const store = () => {
    setWarning(false);
    workspaces.setDataRetention(workspaceId, days).then(
      () => (
        onMessage({ ok: true, text: `Data is kept ${days === null ? "forever" : `for ${describe(days)}`}.` }),
        refetch()
      ),
      (e: Error) => onMessage({ ok: false, text: e.message }),
    );
  };
  return (
    <form className={`card warning-card ${manage ? "" : "disabled"}`} onSubmit={save}>
      <div className="warning-card-body">
        <h3>Keep data</h3>
        <p>How long Kairos keeps events, decisions, cases and logs. Definitions and API keys are never deleted.</p>
        <div className="row">
          <select className="input" value={choice} disabled={locked} onChange={(e) => setChoice(e.target.value)}>
            <option value="forever">Forever</option>
            {PERIODS.map((p) => (
              <option key={p} value={String(p)}>
                {describe(p)}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
          {choice === "custom" && (
            <input
              className="input"
              type="number"
              min={7}
              max={3650}
              step={1}
              placeholder="Days (7 to 3650)"
              value={custom}
              disabled={locked}
              onChange={(e) => setCustom(e.target.value)}
              aria-label="Days to keep data"
            />
          )}
        </div>
      </div>
      <div className="warning-card-foot">
        <span>
          Older data is deleted permanently, in every environment.{" "}
          <a href={RETENTION_DOCS} target="_blank" rel="noreferrer">
            How data retention works
          </a>
          {!manage && ". Only owners and admins can change this."}
        </span>
        <button className="btn solid-warning" disabled={locked || !valid || days === saved}>
          Save
        </button>
      </div>
      {warning && days !== null && (
        <RetentionWarning
          from={saved === null ? "forever" : `for ${describe(saved)}`}
          to={describe(days)}
          onCancel={() => setWarning(false)}
          onConfirm={store}
        />
      )}
    </form>
  );
}

export function GeneralPage({ workspace, session, onChange }: SettingsPageProps) {
  const manage = workspace.role !== "member";
  const [name, setName] = useState(workspace.name);
  const [message, setMessage] = useState<Message>(null);
  const [deleting, setDeleting] = useState(false);
  const fail = (e: Error) => setMessage({ ok: false, text: e.message });

  const save = (event: FormEvent) => {
    event.preventDefault();
    workspaces
      .rename(workspace.id, name)
      .then(() => (setMessage({ ok: true, text: "Workspace name updated." }), onChange()), fail);
  };
  const leave = () =>
    window.confirm("Leave this workspace? You'll need a new invite to rejoin.") &&
    workspaces.removeMember(workspace.id, session.user.id).then(() => (go("overview"), onChange()), fail);

  return (
    <>
      <h1>Workspace</h1>
      <Banner message={message} />

      <Group title="General">
        <form className="card rows" onSubmit={save}>
          <Row
            title="Name"
            note={manage ? "Visible to everyone in the workspace." : "Only owners and admins can change this."}
          >
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              disabled={!manage}
            />
            {manage && (
              <button className="btn" disabled={!name.trim() || name.trim() === workspace.name}>
                Save
              </button>
            )}
          </Row>
          <Row title="Workspace ID" note="The unique identifier for this workspace.">
            <Copy value={workspace.id} />
          </Row>
          <Row title="Your role">
            <span className="muted" style={{ textTransform: "capitalize" }}>
              {workspace.role}
            </span>
          </Row>
          <Row title="Created">
            <span className="muted">{dayOf(workspace.created)}</span>
          </Row>
        </form>
      </Group>

      <Group title="Case layouts">
        <MediaHosts workspaceId={workspace.id} manage={manage} onMessage={setMessage} />
      </Group>

      <Group title="Data retention">
        <DataRetention workspaceId={workspace.id} manage={manage} onMessage={setMessage} />
      </Group>

      <Group title="Danger zone">
        <div className="card rows danger">
          <Row title="Leave workspace" note="You'll lose access until someone invites you back.">
            <button className="btn danger" onClick={leave}>
              Leave workspace
            </button>
          </Row>
          {workspace.role === "owner" && (
            <Row title="Delete workspace" note="Permanently delete this workspace and all of its data.">
              <button className="btn danger" onClick={() => setDeleting(true)}>
                Delete workspace
              </button>
            </Row>
          )}
        </div>
      </Group>

      {deleting && (
        <DeleteWorkspace
          workspace={workspace}
          onClose={() => setDeleting(false)}
          onDeleted={() => (go("overview"), onChange())}
        />
      )}
    </>
  );
}
