import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useNavigate } from "react-router";
import { api, workflows } from "../../api/index";
import { InTopbar } from "../../components/shell/InTopbar";
import { StepPalette } from "../../components/workflows/StepPalette";
import { RunModal } from "../../components/workflows/RunModal";
import { WorkflowMenu } from "../../components/workflows/WorkflowMenu";
import { NARROW, WorkflowTabs } from "../../components/workflows/WorkflowTabs";
import { StepSettings, type Suggestions } from "../../components/workflows/StepSettings";
import { TestPanel } from "../../components/workflows/TestPanel";
import { TriggerSettings } from "../../components/workflows/TriggerSettings";
import { WorkflowCanvas } from "../../components/workflows/WorkflowCanvas";
import { Failure, Loading } from "../../components/ui/states";
import { useActions, useApi, useEntityTypeList, useModels, useQueues, useWorkflows } from "../../hooks/useApi";
import { useMedia } from "../../hooks/useMedia";
import { scoreStepProblems } from "../../lib/models";
import { useWorkflowDraft } from "../../hooks/useWorkflowDraft";
import { useWorkflowRun } from "../../hooks/useWorkflowRun";
import { checkAnswers, inputProblems, inputsOf, kindOf } from "../../lib/workflows";
import {
  duplicate,
  findStep,
  freshId,
  freshName,
  insertStep,
  MAX_DEPTH,
  moveStep,
  problemsOf,
  removeStep,
  renameId,
  slotDepth,
  slotOf,
  slugId,
  stepOfServerProblem,
  updateStep,
  walk,
  type Slot,
} from "../../lib/workflowTree";
import type { WorkflowDefinition, WorkflowDraft, WorkflowStep } from "../../types/interfaces";

type Panel =
  { kind: "palette"; slot: Slot } | { kind: "step"; id: string } | { kind: "trigger" } | { kind: "test" } | null;

const BLANK: WorkflowDraft = { name: "", enabled: true, trigger: { type: "manual" }, steps: [] };

/** What the server has: the live version (0 before the first publish), the switch, and whether a draft waits. */
interface ServerState {
  version: number;
  enabled: boolean;
  hasDraft: boolean;
  archived: boolean;
  /** The live version starts by hand: the builder can run it. */
  manual: boolean;
  /** The live version starts on a call to its URL, and a delivery now starts a run. */
  hookLive: boolean;
  hookHint?: string;
  live: Pick<WorkflowDefinition, "trigger" | "steps">;
}

/** The builder edits the draft when there is one, and the live version when there is none. */
const editableOf = (w: WorkflowDefinition): WorkflowDraft => ({
  name: w.name,
  ...(w.displayName ? { displayName: w.displayName } : {}),
  enabled: w.enabled,
  trigger: (w.draft ?? w).trigger,
  steps: (w.draft ?? w).steps,
});
const serverOf = (w: WorkflowDefinition): ServerState => ({
  version: w.version,
  enabled: w.enabled,
  hasDraft: !!w.draft || w.status === "draft",
  archived: w.status === "archived",
  manual: w.version > 0 && w.trigger.type === "manual",
  hookLive: w.status === "published" && w.enabled && w.trigger.type === "webhook",
  hookHint: w.hook?.hint,
  live: { trigger: w.trigger, steps: w.steps },
});
const END: Slot = { parent: null, branch: "steps", index: Number.MAX_SAFE_INTEGER };
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

function placeOf(steps: WorkflowStep[], slot: Slot): string {
  if (slot.parent === null) return slot.index >= steps.length ? "at the end" : "here";
  const parent = findStep(steps, slot.parent);
  const way = slot.branch === "then" ? "under if" : slot.branch === "else" ? "under else" : "in the loop";
  return parent ? `${way} of "${parent.name}"` : "here";
}

export function WorkflowBuilderPage({ name }: { name: string }) {
  const isNew = name === "new";
  const navigate = useNavigate();
  const { data: existing, error: loadError } = useApi(["workflow", name, "live"], () => workflows.get(name), {
    enabled: !isNew,
  });
  const { data: all } = useWorkflows();
  const { data: actionList } = useActions();
  const { data: typeList } = useEntityTypeList();
  const { data: queueList } = useQueues();
  const { data: modelList } = useModels();
  const { draft, saved: lastSaved, dirty, canUndo, canRedo, change, undo, redo, reset } = useWorkflowDraft(BLANK);
  const { data: options } = useApi(["metric-options", undefined], () => api.metricOptions());
  const triggerEvent =
    draft.trigger.type === "event" && typeof draft.trigger.event === "string" && draft.trigger.event
      ? draft.trigger.event
      : undefined;
  const { data: eventOptions } = useApi(["metric-options", triggerEvent], () => api.metricOptions(triggerEvent), {
    enabled: !!triggerEvent,
  });
  const suggestions: Suggestions = useMemo(
    () => ({
      actions: actionList?.actions.map((a) => a.name) ?? [],
      entityTypes: typeList?.types.map((t) => t.type) ?? [],
      eventTypes: options?.event_types ?? [],
      eventProperties: eventOptions?.event_properties.map((p) => p.name) ?? [],
      queues: queueList?.queues.map((q) => ({ id: q.id, name: q.name })) ?? [],
      models: modelList?.models ?? [],
    }),
    [actionList, typeList, options, eventOptions, queueList, modelList],
  );

  const [server, setServer] = useState<ServerState | null>(null);
  const [panel, setPanel] = useState<Panel>({ kind: "trigger" });
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [testId, setTestId] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const { run: testRun, marks } = useWorkflowRun(testId);
  const loaded = useRef(false);
  const leaving = useRef(false);

  useEffect(() => {
    if (!existing || loaded.current) return;
    loaded.current = true;
    const definition = editableOf(existing);
    reset(definition);
    setServer(serverOf(existing));
    setPanel(definition.steps.length ? null : { kind: "palette", slot: END });
  }, [existing, reset]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.bad ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    return !leaving.current && dirty && currentLocation.pathname !== nextLocation.pathname;
  });
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm("Leave the builder? The changes that are not saved are lost.")) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    const stay = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", stay);
    return () => window.removeEventListener("beforeunload", stay);
  }, [dirty]);

  const steps = draft.steps;
  // An action has one published decision workflow.
  const decisionTaken = useMemo(() => {
    if (draft.trigger.type !== "decision" || !draft.trigger.action) return null;
    const other = all?.workflows.find(
      (w) =>
        w.name !== draft.name &&
        w.status === "published" &&
        w.trigger.type === "decision" &&
        w.trigger.action === draft.trigger.action,
    );
    return other ? other.displayName || other.name : null;
  }, [all, draft.name, draft.trigger]);
  // The key is made from the name, so a problem with it is a problem with the name.
  const keyProblem = !draft.name
    ? "Name the workflow."
    : !KEY.test(draft.name)
      ? "The name must start with a letter."
      : isNew && all?.workflows.some((w) => w.name === draft.name)
        ? `Another workflow has this name ("${draft.name}"). Choose another name.`
        : null;
  const problems = useMemo(() => {
    const map = new Map<string, string[]>();
    const add = (id: string, message: string) => map.set(id, [...(map.get(id) ?? []), message]);
    for (const p of problemsOf(steps)) add(p.step ?? "workflow", p.message);
    if (modelList) for (const p of scoreStepProblems(steps, modelList.models)) add(p.step, p.message);
    if (keyProblem) add("workflow", keyProblem);
    if (draft.trigger.type === "event" && !draft.trigger.event) add("trigger", "Choose the event type.");
    for (const message of inputProblems(draft.trigger)) add("trigger", message);
    const deciding = draft.trigger.type === "decision";
    for (const p of checkAnswers(steps, { waits: deciding, mustAnswer: deciding }).problems)
      add(p.step ?? "workflow", p.message);
    if (deciding && !draft.trigger.action) add("trigger", "Choose the action whose decisions it makes.");
    if (decisionTaken)
      add("trigger", `The workflow "${decisionTaken}" makes the decisions of "${String(draft.trigger.action)}".`);
    for (const message of serverProblems) {
      const at = stepOfServerProblem(steps, message) ?? (message.startsWith("trigger") ? "trigger" : "workflow");
      add(at, message);
    }
    return map;
  }, [steps, keyProblem, draft.trigger, serverProblems, decisionTaken, modelList]);
  const problemCount = [...problems.values()].reduce((n, list) => n + list.length, 0);

  const edit = useCallback(
    (next: (d: WorkflowDraft) => WorkflowDraft, tag?: string) => {
      setServerProblems([]);
      change(next, tag);
    },
    [change],
  );

  const addStep = (type: string, slot: Slot) => {
    const target = slot.index === END.index ? { ...slot, index: steps.length } : slot;
    const container = type === "condition" || type === "loop";
    if (container && slotDepth(steps, target) + 1 > MAX_DEPTH)
      return setNotice({ text: `Conditions and loops nest at most ${MAX_DEPTH} levels.`, bad: true });
    const ids = new Set(walk(steps).map((e) => e.step.id));
    const names = new Set(walk(steps).map((e) => e.step.name));
    const kind = kindOf(type);
    const stepName = freshName(kind.label, names);
    const step: WorkflowStep = {
      id: freshId(stepName, ids),
      name: stepName,
      type,
      ...structuredClone(kind.defaults),
    };
    edit((d) => ({ ...d, steps: insertStep(d.steps, target, step) }));
    setPanel({ kind: "step", id: step.id });
  };

  const removeSelected = (id: string) => {
    const step = findStep(steps, id);
    if (!step) return;
    const inside = walk([step]).length - 1;
    if (inside > 0 && !window.confirm(`Delete "${step.name}" and the ${inside} steps inside it?`)) return;
    edit((d) => ({ ...d, steps: removeStep(d.steps, id) }));
    setPanel(null);
    setNotice({ text: `Deleted "${step.name}". Undo brings it back.` });
  };

  const payload = (): WorkflowDraft => ({
    ...draft,
    name: draft.name.trim(),
    ...(draft.displayName?.trim() ? { displayName: draft.displayName.trim() } : { displayName: undefined }),
  });

  const failed = (e: unknown, text: string) => {
    const message = e instanceof Error ? e.message : String(e);
    setServerProblems(message.split("; "));
    setNotice({ text, bad: true });
  };

  /** The live version does not change. */
  const save = async () => {
    if (keyProblem) return setNotice({ text: keyProblem, bad: true });
    setBusy(true);
    try {
      const saved = await workflows.saveDraft(payload());
      reset(editableOf(saved));
      setServer(serverOf(saved));
      setServerProblems([]);
      setNotice({
        text:
          saved.draft || saved.status === "draft"
            ? "Saved as a draft. Publish it to make it live."
            : "Saved. It is the live version again.",
      });
      if (isNew) {
        leaving.current = true;
        navigate(`/workflows/${encodeURIComponent(saved.name)}`, { replace: true });
      }
    } catch (e) {
      failed(e, "The server did not save it. The problems are on the steps.");
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (problemCount > 0)
      return setNotice({ text: "Fix the problems first: the steps with a ! show them.", bad: true });
    setBusy(true);
    try {
      const published = await workflows.publish(draft.name);
      reset(editableOf(published));
      setServer(serverOf(published));
      setNotice({ text: `Published as version ${published.version}. New runs use it.` });
    } catch (e) {
      failed(e, "The server did not publish it. The problems are on the steps.");
    } finally {
      setBusy(false);
    }
  };

  const test = async (input: Record<string, unknown>, live: string[]) => {
    setBusy(true);
    setTestError(null);
    try {
      const run = await workflows.test(
        { ...payload(), name: KEY.test(draft.name) ? draft.name : "draft" },
        input,
        live,
      );
      setTestId(run.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setServerProblems(message.split("; "));
      setTestError(message);
    } finally {
      setBusy(false);
    }
  };

  /** Drop the changes that are not saved; with none, drop the saved draft and go back to the live version. */
  const canDiscard = dirty || (!!server?.hasDraft && server.version > 0);
  const discard = async () => {
    setServerProblems([]);
    if (dirty) {
      if (!window.confirm("Discard the changes since the last save?")) return;
      reset(lastSaved);
      return;
    }
    if (!server || !window.confirm(`Discard the draft and go back to version ${server.version}?`)) return;
    try {
      const live = await workflows.discardDraft(draft.name);
      reset(editableOf(live));
      setServer(serverOf(live));
      setPanel(null);
    } catch (e) {
      failed(e, "The draft was not discarded.");
    }
  };

  const toggle = async () => {
    if (!server) return;
    try {
      const changed = await workflows.update(draft.name, { enabled: !server.enabled });
      setServer({ ...server, enabled: changed.enabled });
      setNotice({
        text: changed.enabled ? "Active: the trigger starts runs." : "Paused: the trigger starts no new runs.",
      });
    } catch (e) {
      failed(e, e instanceof Error ? e.message : String(e));
    }
  };

  const restore = async () => {
    try {
      const restored = await workflows.restore(draft.name);
      setServer(serverOf(restored));
      setNotice({ text: "Restored. Its trigger starts runs again when it is published and active." });
    } catch (e) {
      failed(e, e instanceof Error ? e.message : String(e));
    }
  };

  const [running, setRunning] = useState(false);
  const narrow = useMedia(NARROW);
  const [toolsOpen, setToolsOpen] = useState(false);

  const archive = async () => {
    const label = draft.displayName || draft.name;
    if (
      !window.confirm(
        `Archive "${label}"? It starts no new runs and leaves the list. Its runs and versions stay, and it can be restored.`,
      )
    )
      return;
    try {
      await workflows.archive(draft.name);
      leaving.current = true;
      navigate("/workflows");
    } catch (e) {
      failed(e, e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty || !server) void save();
        return;
      }
      if (typing(event.target)) return;
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if ((event.key === "Delete" || event.key === "Backspace") && panel?.kind === "step") {
        event.preventDefault();
        removeSelected(panel.id);
      } else if (event.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (loadError) return <Failure message={loadError.message} />;
  if (!isNew && !existing) return <Loading />;

  const selected = panel?.kind === "step" ? panel.id : panel?.kind === "trigger" ? "trigger" : null;
  const selectedStep = panel?.kind === "step" ? findStep(steps, panel.id) : undefined;
  const workflowProblems = problems.get("workflow") ?? [];

  const editTools = !server?.archived && (
    <>
      <button
        type="button"
        className="btn wf-icon-btn"
        onClick={undo}
        disabled={!canUndo}
        title="Undo (⌘Z)"
        aria-label="Undo"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M7.5 5 4 8.5 7.5 12M4.5 8.5H12a4 4 0 0 1 0 8H9" />
        </svg>
      </button>
      <button
        type="button"
        className="btn wf-icon-btn"
        onClick={redo}
        disabled={!canRedo}
        title="Redo (⇧⌘Z)"
        aria-label="Redo"
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M12.5 5 16 8.5 12.5 12M15.5 8.5H8a4 4 0 0 0 0 8h3" />
        </svg>
      </button>
      <button type="button" className="btn" onClick={() => setPanel({ kind: "palette", slot: END })}>
        + Add a step
      </button>
      {canDiscard && (
        <button type="button" className="btn" onClick={() => void discard()}>
          Discard
        </button>
      )}
      {server?.manual && server.enabled && !dirty && (
        <button type="button" className="btn" onClick={() => setRunning(true)} title="Run the live version now">
          Run
        </button>
      )}
    </>
  );
  const mainTool = server?.archived ? (
    <button type="button" className="btn primary" onClick={() => void restore()}>
      Restore
    </button>
  ) : dirty || !server ? (
    <button
      type="button"
      className="btn primary"
      disabled={busy || !!keyProblem}
      title={keyProblem ?? "Save the changes as a draft (⌘S)"}
      onClick={() => void save()}
    >
      {busy ? "Saving…" : "Save"}
    </button>
  ) : (
    <button
      type="button"
      className="btn primary"
      disabled={busy || !server.hasDraft || problemCount > 0}
      title={
        !server.hasDraft
          ? "Nothing to publish: the live version has every change"
          : problemCount > 0
            ? "Fix the problems first"
            : "Make the draft the live version"
      }
      onClick={() => void publish()}
    >
      {busy ? "Publishing…" : "Publish"}
    </button>
  );
  const tabs = <WorkflowTabs name={server ? draft.name : undefined} current="builder" />;
  const menu = (
    <WorkflowMenu
      name={draft.name}
      saved={!!server}
      published={!!server && server.version > 0}
      enabled={server?.enabled ?? true}
      archived={server?.archived ?? false}
      onToggle={() => void toggle()}
      onArchive={() => void archive()}
    />
  );

  return (
    <div className={`wf-builder ${narrow ? "with-tabs" : ""} ${narrow && toolsOpen ? "with-tools" : ""}`}>
      <InTopbar slot="trail-slot">
        <span className="wf-toolbar-name">
          <input
            className="wf-title-input big"
            placeholder="Name the workflow"
            aria-label="Workflow name"
            value={draft.displayName ?? ""}
            onChange={(e) => {
              const displayName = e.target.value;
              // A new workflow's key comes from its name. It does not change after the first save.
              const key = isNew ? (displayName.trim() ? slugId(displayName) : "") : undefined;
              edit((d) => ({ ...d, displayName, ...(key !== undefined ? { name: key } : {}) }), "displayName");
            }}
          />
          {!narrow && tabs}
        </span>
      </InTopbar>
      {narrow && <div className="wf-tabs-bar">{tabs}</div>}
      <InTopbar slot="topbar-slot">
        {narrow ? (
          <button
            type="button"
            className={`btn wf-icon-btn wf-tools-toggle ${toolsOpen ? "on" : ""}`}
            onClick={() => setToolsOpen(!toolsOpen)}
            aria-expanded={toolsOpen}
            aria-controls="wf-tools"
            aria-label={toolsOpen ? "Hide the tools" : "Show the tools"}
            title={toolsOpen ? "Hide the tools" : "Show the tools"}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 6h12M4 10h12M4 14h12" />
              <circle cx="7" cy="6" r="1.6" />
              <circle cx="13" cy="10" r="1.6" />
              <circle cx="9" cy="14" r="1.6" />
            </svg>
            {dirty && <i className="wf-tools-dot" aria-hidden="true" />}
          </button>
        ) : (
          <>
            {editTools}
            {mainTool}
            {menu}
          </>
        )}
      </InTopbar>
      {narrow && toolsOpen && (
        <div id="wf-tools" className="wf-tools-bar" role="toolbar" aria-label="Workflow tools">
          {editTools && <div className="wf-tools-group">{editTools}</div>}
          <div className="wf-tools-group end">
            {menu}
            {mainTool}
          </div>
        </div>
      )}

      <div className={`wf-stage ${panel ? "with-panel" : ""}`}>
        <div className="wf-state">
          {dirty ? (
            <span className="wf-draft">Unsaved changes</span>
          ) : server?.hasDraft ? (
            <span className="wf-draft">Draft</span>
          ) : server?.archived ? (
            <span className="chip">Archived</span>
          ) : server ? (
            <span className="chip accent">Version {server.version}</span>
          ) : null}
          {server && server.version > 0 && (dirty || server.hasDraft) && (
            <span className="chip">Live: version {server.version}</span>
          )}
          {server && server.version > 0 && !server.enabled && <span className="chip warn">Paused</span>}
          {problemCount > 0 && (
            <button
              type="button"
              className="wf-problem-count"
              onClick={() => {
                const first = [...problems.keys()].find((k) => k !== "workflow");
                if (first === "trigger") setPanel({ kind: "trigger" });
                else if (first) setPanel({ kind: "step", id: first });
                else setNotice({ text: workflowProblems[0] ?? "", bad: true });
              }}
            >
              {problemCount} {problemCount === 1 ? "problem" : "problems"}
            </button>
          )}
        </div>
        <WorkflowCanvas
          definition={draft}
          editable={!server?.archived}
          selected={selected}
          problems={problems}
          marks={panel?.kind === "test" ? marks : undefined}
          onSelect={(id) => setPanel(id === "trigger" ? { kind: "trigger" } : id ? { kind: "step", id } : null)}
          onAddAt={(slot) => setPanel({ kind: "palette", slot })}
          onDropNew={addStep}
          onMove={(id, slot) => {
            edit((d) => ({ ...d, steps: moveStep(d.steps, id, slot) }));
            setPanel({ kind: "step", id });
          }}
          onRefuse={(text) => setNotice({ text, bad: true })}
        />
        {notice && <div className={`wf-notice ${notice.bad ? "bad" : ""}`}>{notice.text}</div>}
        {workflowProblems.length > 0 && serverProblems.length > 0 && (
          <div className="wf-notice bad top">{workflowProblems.join(" ")}</div>
        )}

        {panel && (
          <aside className="wf-side">
            {panel.kind === "palette" && (
              <StepPalette
                where={placeOf(steps, panel.slot)}
                deepest={slotDepth(steps, panel.slot) >= MAX_DEPTH}
                onPick={(type) => addStep(type, panel.slot)}
                onClose={() => setPanel(null)}
              />
            )}
            {panel.kind === "trigger" && (
              <TriggerSettings
                choose={!server && steps.length === 0}
                name={draft.name}
                trigger={draft.trigger}
                eventTypes={suggestions.eventTypes}
                entityTypes={suggestions.entityTypes}
                actions={suggestions.actions}
                eventProperties={suggestions.eventProperties}
                steps={steps}
                decisionTaken={decisionTaken}
                hook={server ? { hint: server.hookHint, live: server.hookLive } : undefined}
                onNewHook={async () => {
                  const made = await workflows.newHook(draft.name);
                  setServer((s) => (s ? { ...s, hookHint: made.hint } : s));
                  return made.path;
                }}
                onChange={(trigger, tag) => edit((d) => ({ ...d, trigger }), tag)}
                onClose={() => setPanel(null)}
              />
            )}
            {panel.kind === "step" && selectedStep && (
              <StepSettings
                key={selectedStep.id}
                draft={draft}
                step={selectedStep}
                problems={problems.get(selectedStep.id) ?? []}
                suggestions={suggestions}
                onChange={(step, tag) => edit((d) => ({ ...d, steps: updateStep(d.steps, step.id, () => step) }), tag)}
                onRename={(to) => {
                  const from = selectedStep.id;
                  edit((d) => ({ ...d, steps: renameId(d.steps, from, to) }));
                  setPanel({ kind: "step", id: to });
                  return null;
                }}
                onDuplicate={() => {
                  const ids = new Set(walk(steps).map((e) => e.step.id));
                  const names = new Set(walk(steps).map((e) => e.step.name));
                  const copy = duplicate(selectedStep, ids, names);
                  const at = slotOf(steps, selectedStep.id)!;
                  edit((d) => ({ ...d, steps: insertStep(d.steps, { ...at, index: at.index + 1 }, copy) }));
                  setPanel({ kind: "step", id: copy.id });
                }}
                onDelete={() => removeSelected(selectedStep.id)}
                onClose={() => setPanel(null)}
              />
            )}
            {panel.kind === "test" && (
              <TestPanel
                draft={draft}
                run={testRun}
                busy={busy}
                error={testError}
                onRun={(input, live) => void test(input, live)}
                onClear={() => setTestId(null)}
                onClose={() => setPanel(null)}
              />
            )}
          </aside>
        )}
      </div>
      {running && server && (
        <RunModal
          name={draft.name}
          title={draft.displayName || draft.name}
          version={server.version}
          inputs={inputsOf(server.live.trigger)}
          steps={server.live.steps}
          onClose={() => setRunning(false)}
          onStarted={(run) => {
            setRunning(false);
            navigate(`/workflows/${encodeURIComponent(draft.name)}/runs/${encodeURIComponent(run.id)}`);
          }}
        />
      )}
    </div>
  );
}
