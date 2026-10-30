import { useState } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import type { Member } from "../../types/interfaces";

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/**
 * Who works a case: you first, then the other members. With an assignee, the case can also be unassigned.
 * With `many`, the choice goes to several cases, so every choice, Unassign too, is always offered.
 */
export function AssignMenu({
  me,
  assignee,
  members,
  disabled,
  many,
  onAssign,
}: {
  me: string;
  assignee: { id: string; name: string } | null;
  members: Member[];
  disabled?: boolean;
  many?: boolean;
  onAssign: (userId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const ref = useDismiss(open, () => setOpen(false));
  const active = members.filter((m) => m.status === "active");
  const self = active.find((m) => m.id === me);
  const others = active
    .filter((m) => m.id !== me)
    .filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(find.trim().toLowerCase()));
  const pick = (id: string | null) => {
    setOpen(false);
    setFind("");
    if (many || id !== (assignee?.id ?? null)) onAssign(id);
  };
  const row = (m: Member, you: boolean) => (
    <button key={m.id} role="menuitemradio" aria-checked={assignee?.id === m.id} onClick={() => pick(m.id)}>
      <span className="mark plus">{initials(m.name || m.email)}</span>
      <span className="grow">
        {m.name || m.email}
        {you && <span className="muted"> (you)</span>}
      </span>
      {assignee?.id === m.id && <span aria-hidden>✓</span>}
    </button>
  );
  return (
    <div className="menu-anchor" ref={ref}>
      <button
        type="button"
        className="btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {assignee && !many ? "Reassign" : "Assign"}
        <svg className="caret" viewBox="0 0 20 20" aria-hidden>
          <path d="m6 8 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="menu end assign-menu" role="menu">
          {self && row(self, true)}
          {active.length > 1 && <hr />}
          {active.length > 7 && (
            <input
              className="input compact"
              placeholder="Find a member"
              value={find}
              autoFocus
              onChange={(e) => setFind(e.target.value)}
            />
          )}
          {active.length > 1 && <div className="menu-label">Members</div>}
          {others.map((m) => row(m, false))}
          {active.length > 1 && others.length === 0 && <div className="menu-who muted">No member matches.</div>}
          {(assignee || many) && (
            <>
              <hr />
              <button role="menuitem" onClick={() => pick(null)}>
                <span className="grow">Unassign</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
