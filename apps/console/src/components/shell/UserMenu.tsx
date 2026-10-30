import { useState } from "react";
import { readTheme, saveTheme } from "../../theme";
import type { Session } from "../../types/interfaces";
import { go } from "../../lib/route";
import { useDismiss } from "../../hooks/useDismiss";

/** The theme on the screen now: a "system" theme is the one the device shows. */
const isDark = () => {
  const theme = readTheme();
  return theme === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : theme === "dark";
};

export function UserMenu({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const { user } = session;
  return (
    <div className="menu-anchor" ref={ref}>
      <button
        className="avatar"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user.email}
      >
        {(user.name || user.email)[0]!.toUpperCase()}
      </button>
      {open && (
        <div className="menu end" role="menu">
          <div className="menu-who">
            <b>{user.name || user.email}</b>
            <small>{user.email}</small>
          </div>
          <hr />
          <button role="menuitem" onClick={() => (setOpen(false), go("settings", "profile"))}>
            Profile
          </button>
          <button role="menuitem" onClick={() => (setOpen(false), go("settings", "general"))}>
            Settings
          </button>
          <button role="menuitem" onClick={() => (setOpen(false), saveTheme(isDark() ? "light" : "dark"))}>
            {isDark() ? "Lights on" : "Lights off"}
          </button>
          <hr />
          <button role="menuitem" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
