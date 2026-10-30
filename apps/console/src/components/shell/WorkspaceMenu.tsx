import { useState } from "react";
import type { Environment, Session } from "../../types/interfaces";
import { go, href } from "../../lib/route";
import { useDismiss } from "../../hooks/useDismiss";

export function WorkspaceMenu({
  session,
  workspaceId,
  environment,
  onChooseEnvironment,
  onChoose,
  onSearch,
}: {
  session: Session;
  workspaceId: string;
  environment: Environment;
  onChooseEnvironment: (id: string) => void;
  onChoose: (id: string) => void;
  onSearch: () => void;
}) {
  const current = session.workspaces.find((w) => w.id === workspaceId)!;
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div className="side-head">
      <div className="menu-anchor" ref={ref}>
        <button className="project" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
          <span className="mark">{current.name[0]?.toUpperCase()}</span>
          <b>{current.name}</b>
          <svg className="caret" viewBox="0 0 20 20">
            <path d="m6 8 4 4 4-4" />
          </svg>
        </button>
        {open && (
          <div className="menu" role="menu">
            <div className="menu-label">Workspaces</div>
            {session.workspaces.map((w) => (
              <button
                key={w.id}
                role="menuitem"
                className={w.id === workspaceId ? "on" : ""}
                onClick={() => (setOpen(false), w.id !== workspaceId && (onChoose(w.id), go("overview")))}
              >
                <span className="mark">{w.name[0]?.toUpperCase()}</span>
                <span className="grow">
                  {w.name}
                  <small>{w.role}</small>
                </span>
                {w.id === workspaceId && <span className="muted">✓</span>}
              </button>
            ))}
            <hr />
            <div className={`environment-picker ${environment.kind}`}>
              <label>
                <span>
                  Environment <small>{environment.kind === "production" ? "Production" : "Sandbox"}</small>
                </span>
                <select
                  className="input"
                  aria-label="Environment"
                  value={environment.id}
                  onChange={(e) => {
                    setOpen(false);
                    onChooseEnvironment(e.target.value);
                  }}
                >
                  {current.environments.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                      {e.kind === "sandbox" ? " · Sandbox" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <a href={href("settings", "environments")} onClick={() => setOpen(false)}>
                Manage environments
              </a>
            </div>
            <hr />
            <button role="menuitem" onClick={() => (setOpen(false), go("settings", "general"))}>
              <span className="mark plus">⚙</span>
              Settings
            </button>
            {current.role !== "member" && (
              <button role="menuitem" onClick={() => (setOpen(false), go("settings", "members"))}>
                <span className="mark plus">＋</span>
                Invite people
              </button>
            )}
            <hr />
            <button role="menuitem" onClick={() => (setOpen(false), go("workspaces", "new"))}>
              <span className="mark plus">+</span>
              New workspace
            </button>
          </div>
        )}
      </div>
      <button className="side-icon" onClick={onSearch} aria-label="Search" title="Search (⌘K)">
        <svg viewBox="0 0 20 20">
          <circle cx="9" cy="9" r="5" />
          <path d="m13 13 3.5 3.5" />
        </svg>
      </button>
    </div>
  );
}
