import { FormEvent, useEffect, useState } from "react";
import { renderSVG } from "uqr";
import { auth } from "../../api/index";
import { ApiError } from "../../api/client";
import type { MfaStatus } from "../../types/interfaces";
import type { Message } from "../ui/Banner";
import { Group, Row } from "../ui/Group";
import { Modal } from "../ui/Modal";
import { Switch } from "../ui/Switch";

/** Cognito asks for the password (and the code) again, then comes back to this page. */
const signInAgain = () =>
  window.location.assign(`/auth/cognito/start?${new URLSearchParams({ reauth: "1", next: "/#/settings/profile" })}`);

/**
 * Two-factor authentication with an authenticator app, for an account that signs in to Cognito
 * with a password. Cognito keeps it: turning it on shows a QR code and checks a first code;
 * turning it off needs a recent sign-in.
 */
export function TwoFactor({ onMessage }: { onMessage: (message: Message) => void }) {
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState(false);
  const [confirm, setConfirm] = useState<"on" | "off" | null>(null);

  useEffect(() => {
    auth.mfa().then(setStatus, () => setStatus(null));
  }, []);

  if (!status || (!status.available && status.reason === "not_cognito")) return null;

  if (!status.available)
    return (
      <Group title="Two-factor authentication">
        <div className="card rows">
          <Row
            title="Managed by Google"
            note="You sign in with Google. Turn on 2-Step Verification in your Google account."
          />
        </div>
      </Group>
    );

  const turnOff = () =>
    auth.mfaDisable().then(
      () => (
        setStatus({ ...status, enabled: false }),
        onMessage({ ok: true, text: "Two-factor authentication is off." })
      ),
      (e: ApiError) => (e.status === 403 ? setConfirm("off") : onMessage({ ok: false, text: e.message })),
    );

  return (
    <Group title="Two-factor authentication">
      <div className="card rows">
        {status.reauth_required ? (
          <Row title="Authenticator app" note="Sign in again to see or change two-factor authentication.">
            <button className="btn" onClick={signInAgain}>
              Sign in again
            </button>
          </Row>
        ) : (
          <Row
            title="Authenticator app"
            note={
              status.enabled
                ? "On. Kairos asks for a code from your app each time you sign in."
                : "Off. Turn it on to ask for a code from an authenticator app at each sign-in."
            }
          >
            <Switch
              checked={!!status.enabled}
              title="Two-factor authentication"
              onChange={(on) => (on ? setSetup(true) : turnOff())}
            />
          </Row>
        )}
      </div>
      {setup && (
        <SetUp
          onClose={() => setSetup(false)}
          onReauth={() => (setSetup(false), setConfirm("on"))}
          onDone={() => (
            setSetup(false),
            setStatus({ ...status, enabled: true }),
            onMessage({ ok: true, text: "Two-factor authentication is on." })
          )}
        />
      )}
      {confirm && (
        <Modal title="Confirm it's you" onClose={() => setConfirm(null)}>
          <div className="modal-body">
            <p>
              {confirm === "off"
                ? "To turn off two-factor authentication, sign in again with your password and a code from your app."
                : "To turn on two-factor authentication, sign in again with your password."}
            </p>
            <p>You'll come back here. Then turn it {confirm}.</p>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button type="button" className="btn primary" onClick={signInAgain}>
                Sign in again
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Group>
  );
}

function SetUp({ onClose, onDone, onReauth }: { onClose: () => void; onDone: () => void; onReauth: () => void }) {
  const [secret, setSecret] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const failed = (e: ApiError) => (e.status === 403 ? onReauth() : setError(e.message));

  useEffect(() => {
    auth.mfaSetup().then(setSecret, failed);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    auth
      .mfaVerify(code)
      .then(onDone, failed)
      .finally(() => setBusy(false));
  };

  return (
    <Modal title="Set up two-factor authentication" onClose={onClose}>
      <form className="modal-body" onSubmit={submit}>
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <p>Scan this code with an authenticator app, such as Google Authenticator, 1Password or Authy.</p>
        {secret ? (
          <>
            <div
              className="qr"
              aria-label="QR code for your authenticator app"
              role="img"
              style={{ width: 180, height: 180, margin: "0 auto", background: "#fff", padding: 8, borderRadius: 8 }}
              // The SVG is made here from the secret, not received as markup.
              dangerouslySetInnerHTML={{ __html: renderSVG(secret.otpauth_uri, { border: 1 }) }}
            />
            <p className="muted" style={{ textAlign: "center", wordBreak: "break-all" }}>
              Or enter this key: <code>{secret.secret}</code>
            </p>
          </>
        ) : (
          !error && <p className="muted">Loading…</p>
        )}
        <label className="field">
          <span>Code from the app</span>
          <input
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            required
            autoFocus
          />
        </label>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!secret || code.length !== 6 || busy}>
            Turn on
          </button>
        </div>
      </form>
    </Modal>
  );
}
