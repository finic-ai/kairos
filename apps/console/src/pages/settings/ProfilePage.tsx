import { FormEvent, useState } from "react";
import { auth } from "../../api/index";
import { DeleteAccount } from "../../components/settings/DeleteAccount";
import { TwoFactor } from "../../components/settings/TwoFactor";
import { Banner, type Message } from "../../components/ui/Banner";
import { Group, Row } from "../../components/ui/Group";
import type { SettingsPageProps } from "./types";

export function ProfilePage({ session, onChange, onSignedOut }: SettingsPageProps) {
  const { user } = session;
  const [name, setName] = useState(user.name);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [message, setMessage] = useState<Message>(null);
  const [deleting, setDeleting] = useState(false);
  const fail = (e: Error) => setMessage({ ok: false, text: e.message });

  const saveName = (event: FormEvent) => {
    event.preventDefault();
    auth.rename(name).then(() => (setMessage({ ok: true, text: "Name updated." }), onChange()), fail);
  };
  const savePassword = (event: FormEvent) => {
    event.preventDefault();
    if (next !== again) return setMessage({ ok: false, text: "Passwords don't match." });
    auth.password(current, next).then(({ sessions_ended }) => {
      (setCurrent(""), setNext(""), setAgain(""));
      setMessage({
        ok: true,
        text: `Password updated.${sessions_ended ? ` Signed out of ${sessions_ended} other ${sessions_ended === 1 ? "session" : "sessions"}.` : ""}`,
      });
      onChange();
    }, fail);
  };

  return (
    <>
      <h1>Profile</h1>
      <Banner message={message} />

      <Group title="Account">
        <form className="card rows" onSubmit={saveName}>
          <Row title="Name" note="How you appear to teammates.">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoComplete="name"
              required
            />
            <button className="btn" disabled={!name.trim() || name.trim() === user.name}>
              Save
            </button>
          </Row>
          <Row title="Email" note="Used to sign in.">
            <span className="muted">{user.email}</span>
          </Row>
        </form>
      </Group>

      {user.has_password ? (
        <Group title="Password" note="Changing your password signs you out everywhere else.">
          <form className="card rows" onSubmit={savePassword}>
            <Row title="Current password">
              <input
                className="input"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Row>
            <Row title="New password" note="8 characters minimum.">
              <input
                className="input"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </Row>
            <Row title="Confirm new password">
              <input
                className="input"
                type="password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </Row>
            <Row title="">
              <button className="btn primary">Update password</button>
            </Row>
          </form>
        </Group>
      ) : (
        <Group title="Password">
          <div className="card rows">
            <Row
              title="Signed in elsewhere"
              note="Kairos keeps no password for this account. Your sign-in provider keeps your password and two-factor authentication."
            />
          </div>
        </Group>
      )}

      <TwoFactor onMessage={setMessage} />

      <Group title="Sessions">
        <div className="card rows">
          <Row title="Sign out" note="Sign out of Kairos on this device.">
            <button className="btn" onClick={() => auth.logout().then(onSignedOut, onSignedOut)}>
              Sign out
            </button>
          </Row>
        </div>
      </Group>

      <Group title="Danger zone">
        <div className="card rows danger">
          <Row title="Delete account" note="Permanently delete your account and leave all workspaces.">
            <button className="btn danger" onClick={() => setDeleting(true)}>
              Delete account
            </button>
          </Row>
        </div>
      </Group>

      {deleting && <DeleteAccount session={session} onClose={() => setDeleting(false)} onDeleted={onSignedOut} />}
    </>
  );
}
