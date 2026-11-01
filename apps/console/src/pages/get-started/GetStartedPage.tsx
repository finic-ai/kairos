import { useEffect, useState } from "react";
import { workspaces } from "../../api/index";
import type { Session } from "../../types/interfaces";
import type { Workspace } from "../../types/interfaces";
import { Code } from "../../components/get-started/Code";
import { CopyButton } from "../../components/get-started/CopyButton";
import { Steps } from "../../components/get-started/Steps";
import { TaskList, type Task } from "../../components/get-started/TaskList";
import { useStartProgress } from "../../hooks/useStartProgress";
import { href } from "../../lib/route";

export function GetStartedPage({
  workspace,
  session,
  hidden,
  onShow,
}: {
  workspace: Workspace;
  session: Session;
  hidden?: boolean;
  onShow?: () => void;
}) {
  const { done, checked } = useStartProgress(workspace.id, 4000);

  const [mode, setMode] = useState<"agent" | "manual">("agent");
  const [key, setKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const admin = workspace.role !== "member";
  const base = window.location.origin;
  const shownKey = key ?? "<your secret key>";
  const createKey = () =>
    workspaces
      .createKey(workspace.id, { name: "Get started", kind: "secret", allowed_ips: [], allowed_origins: [] })
      .then(
        (created) => (setKey(created.secret), setKeyError(null)),
        (e: Error) => setKeyError(e.message),
      );

  const prompt = `# Add Kairos to this application

Kairos makes risk decisions from behaviour. You send it the events of your users, and you ask it for a decision before a risky action. Set it up step by step, and verify that it works.

Kairos API: ${base}
Secret API key: ${shownKey}
Keep the key on the server. Read it from the environment variable KAIROS_API_KEY. Never put it in browser or mobile code.

## 1. Send events

Find where this application handles sign-in, payments, transfers, and changes to contact details or payees. On the server, send one event for each, with the id of the user.

If the @finic-ai/kairos package is available to this project, use it:

  import { Kairos } from "@finic-ai/kairos";
  const kairos = new Kairos({ apiKey: process.env.KAIROS_API_KEY, baseUrl: "${base}" });
  kairos.track("login", { userId: user.id, deviceId, ip_country });

If it is not, call the HTTP API:

  POST ${base}/v1/events
  Authorization: Bearer <KAIROS_API_KEY>
  { "batch": [{ "id": "<unique id>", "type": "login", "ts": "<ISO time>", "entities": { "user": "<user id>" }, "properties": {} }] }

A property whose name ends in Id names an entity: userId, deviceId, merchantId. Every event needs one or more.

## 2. Ask for a decision

Before a risky action (a withdrawal, a transfer, a payout), ask Kairos and act on the answer:

  const decision = await kairos.decide({ type: "<action key>", userId: user.id, amount });
  // decision.decision is "approve", "step_up", "review" or "block"

The action must exist in the Kairos console (Actions). Ask the person which action key to use. If Kairos cannot be reached, do not block the user: fall back to your current behaviour and log the failure.

## 3. Verify

Start the application, sign in once, and confirm that the event shows in the Kairos console. Tell the person what you changed, and which events you send.`;

  const manual = `import { Kairos } from "@finic-ai/kairos";

const kairos = new Kairos({
  apiKey: process.env.KAIROS_API_KEY, // ${key ? "the key you created here" : "a secret key from Settings › API keys"}
  baseUrl: "${base}",
});

// On your server, when something happens:
kairos.track("login", { userId: "user_42", deviceId: "dev_1", ip_country: "GB" });`;

  const curl = `curl -X POST ${base}/v1/events \\
  -H "Authorization: Bearer ${shownKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"batch":[{"id":"evt_1","type":"login","ts":"${new Date().toISOString().slice(0, 19)}Z","entities":{"user":"user_42"},"properties":{"ip_country":"GB"}}]}'`;

  const keyStep = (
    <div className="start-key">
      {key ? (
        <p className="note">
          A secret key named "Get started" is in the text below. Copy it now: it is not shown again after you leave this
          page.
        </p>
      ) : admin ? (
        <>
          <button className="btn" onClick={createKey}>
            Create a secret key
          </button>
          <span className="note">
            It is put into the text below. You can also use a key from{" "}
            <a className="linkish" href={href("settings", "keys")}>
              API keys
            </a>
            .
          </span>
        </>
      ) : (
        <span className="note">Ask an owner or an admin of this workspace for a secret key.</span>
      )}
      {keyError && (
        <span className="note" style={{ color: "var(--block-text)" }}>
          {keyError}
        </span>
      )}
    </div>
  );

  const quick: Task[] = [
    {
      id: "event",
      icon: "event",
      title: "Send your first event",
      note: "Connect your app and tell Kairos what your users do.",
      done: done.event,
      waiting: "Watching for the first event",
      body: (
        <>
          <div className="mode-tabs">
            <button className={mode === "agent" ? "on" : ""} onClick={() => setMode("agent")}>
              Agent setup
            </button>
            <button className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")}>
              Manual setup
            </button>
          </div>
          {mode === "agent" ? (
            <div className="start-split">
              <Steps
                steps={[
                  {
                    title: "Copy the prompt and run it in your coding agent",
                    body: (
                      <>
                        <p>
                          The agent finds where your app handles sign-in and payments, sends those events from your
                          server, and adds a decision before a risky action.
                        </p>
                        {keyStep}
                        <div className="row" style={{ marginTop: 10 }}>
                          <CopyButton text={prompt} label="Copy prompt" primary />
                        </div>
                      </>
                    ),
                  },
                  {
                    title: "Follow the steps in your agent",
                    body: (
                      <p>
                        Review each change before you accept it. The key stays in an environment variable on your
                        server.
                      </p>
                    ),
                  },
                  {
                    title: "Send your first event",
                    body: (
                      <p>
                        Start your app and sign in once. This page shows the event when it arrives, and you can see it
                        under{" "}
                        <a className="linkish" href={href("entities")}>
                          Entities
                        </a>
                        .
                      </p>
                    ),
                  },
                ]}
              />
              <Code title="Installation prompt" text={prompt} />
            </div>
          ) : (
            <div className="start-split">
              <Steps
                steps={[
                  { title: "Get a secret key", body: keyStep },
                  {
                    title: "Send an event from your server",
                    body: (
                      <p>
                        With the SDK, or with one HTTP request. A property whose name ends in Id names an entity:
                        userId, deviceId.
                      </p>
                    ),
                  },
                  { title: "Check that it arrived", body: <p>This page shows the event when it arrives.</p> },
                ]}
              />
              <div className="stack" style={{ gap: 12 }}>
                <Code title="With the SDK" text={manual} lang="typescript" />
                <Code title="With curl" text={curl} lang="bash" />
              </div>
            </div>
          )}
        </>
      ),
    },
    {
      id: "action",
      icon: "action",
      title: "Define your first action",
      note: "Say which decision you want, in plain language.",
      done: done.action,
      body: (
        <>
          <p>
            An action is one decision: a question, the signals to look for, and a policy. For example "Should this
            withdrawal be held?". You can start from a template and change the wording to your product.
          </p>
          <div className="row">
            <a className="btn primary" href={href("actions", "new")}>
              New action
            </a>
            <a className="btn" href={href("actions")}>
              See your actions
            </a>
          </div>
        </>
      ),
    },
    {
      id: "decision",
      icon: "decision",
      title: "Get your first decision",
      note: "Ask Kairos before a risky action, and act on the answer.",
      done: done.decision,
      waiting: done.action ? "Watching for the first decision" : undefined,
      body: (
        <div className="start-split">
          <div>
            <p>
              Call decide from your server at the moment a user asks for the action. The answer is approve, step up,
              review or block, with a risk score and the signals that were found.
            </p>
            <p className="note">
              Use the key of one of your actions as the type. The decision then shows under Decisions.
            </p>
          </div>
          <Code
            title="On your server"
            text={`const decision = await kairos.decide({
  type: "withdrawal", // the key of your action
  userId: "user_42",
  amount: 500,
});

if (decision.decision === "block") {
  // stop it
}`}
          />
        </div>
      ),
    },
  ];

  const more: Task[] = [
    {
      id: "entity",
      icon: "entity",
      title: "Describe an entity",
      note: "Say what a user, a device or a merchant is in your product.",
      done: done.entity,
      body: (
        <>
          <p>
            Events create entities by themselves. A definition adds a description and the meaning of each property, and
            controls whether sharing one links two users.
          </p>
          <a className="btn" href={href("entities")}>
            Open Entities
          </a>
        </>
      ),
    },
    {
      id: "label",
      icon: "label",
      title: "Record an outcome",
      note: "Tell Kairos which decisions were right, with a label.",
      done: done.label,
      body: (
        <>
          <p>
            A label is what you learned later: a confirmed fraud, a chargeback, a legitimate customer. Labels show which
            entities are connected to known fraud, and they let a dashboard count misses and false holds.
          </p>
          <p className="note">
            Add one on a decision page ("Was this right?"), on an entity page, or with kairos.label() from your server.
          </p>
          <a className="btn" href={href("decisions")}>
            Open Decisions
          </a>
        </>
      ),
    },
    {
      id: "dashboard",
      icon: "dashboard",
      title: "Build a dashboard",
      note: "Track the numbers that matter to your team.",
      done: done.dashboard,
      body: (
        <>
          <p>
            A dashboard is your own page of tiles: block rate, top signals, decisions by action. A new one can start
            with the same numbers as the Overview page.
          </p>
          <a className="btn" href={href("dashboards")}>
            Open Dashboards
          </a>
        </>
      ),
    },
    {
      id: "team",
      icon: "team",
      title: "Invite your team",
      note: "Add the people who review decisions or set up the integration.",
      done: done.team,
      body: (
        <>
          <p>
            You create an invite link and send it. A member can view and work with data; an admin can also manage
            members and API keys.
          </p>
          <a className="btn" href={href("settings", "members")}>
            Invite a member
          </a>
        </>
      ),
    },
  ];

  const firstOpen = [...quick, ...more].find((t) => !t.done)?.id ?? null;
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  // Wait for every check, or a task that is done looks open for a moment and stays open.
  useEffect(() => {
    if (open === undefined && checked) setOpen(firstOpen);
  }, [checked]);
  const toggle = (id: string) => setOpen(open === id ? null : id);

  return (
    <div className="start">
      <header className="page-head">
        <div>
          <h1>Get started</h1>
          <p className="lede">
            Hello {session.user.name.split(" ")[0]}. Three steps connect your app. You can{" "}
            <a className="linkish" href={href("settings", "members")}>
              invite a team member
            </a>{" "}
            to help with the installation.
          </p>
        </div>
        {hidden && onShow && (
          <button className="btn" onClick={onShow}>
            Show in the sidebar
          </button>
        )}
      </header>
      <TaskList title="Quick start" tasks={quick} open={open ?? null} onToggle={toggle} />
      <TaskList title="Beyond the basics" tasks={more} open={open ?? null} onToggle={toggle} />
    </div>
  );
}
