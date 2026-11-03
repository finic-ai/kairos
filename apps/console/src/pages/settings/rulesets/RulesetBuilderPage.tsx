import { catalogInput, fromCatalog, INPUT_CATALOG, rulesetSlugProblem, validateRuleset } from "@kairos/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBlocker, useNavigate } from "react-router";
import { lists as listApi, rulesets } from "../../../api/index";
import { InputCatalog } from "../../../components/rulesets/InputCatalog";
import { RulesetCanvas, type Selection } from "../../../components/rulesets/RulesetCanvas";
import { DefaultSettings, RuleSettings, StartSettings, TestPanel } from "../../../components/rulesets/RulesetPanels";
import { Failure, Loading } from "../../../components/ui/states";
import { useApi } from "../../../hooks/useApi";
import { useWorkflowDraft } from "../../../hooks/useWorkflowDraft";
import { slug as slugOf } from "../../../lib/format";
import { hashQuery, href } from "../../../lib/route";
import { BLANK_RULESET, copyRule, editableOf, newRule, problemPlace, problemText } from "../../../lib/rulesets";
import type {
  RulesetDefinition,
  RulesetInput,
  RulesetRule,
  RulesetSummary,
  RulesetTestRun,
  WorkflowInput,
} from "../../../types/interfaces";

interface Draft {
  slug: string;
  name: string;
  description: string;
  settings: Record<string, unknown>;
  definition: RulesetDefinition;
}

interface ServerState {
  slug: string;
  version: number;
  status: RulesetSummary["status"];
  hasDraft: boolean;
}

type Panel = { kind: "select"; at: NonNullable<Selection> } | { kind: "test" } | null;

const BLANK: Draft = { slug: "", name: "", description: "", settings: {}, definition: BLANK_RULESET };

const draftOf = (r: RulesetSummary): Draft => ({
  slug: r.slug,
  name: r.name,
  description: r.description ?? "",
  settings: r.settings,
  definition: editableOf(r),
});
const serverOf = (r: RulesetSummary): ServerState => ({
  slug: r.slug,
  version: r.version,
  status: r.status,
  hasDraft: !!r.draft || r.version === 0,
});

const slugFromName = (name: string) => {
  const base = slugOf(name).replace(/^_+/, "");
  return !base ? "" : /^[a-z]/.test(base) ? base : `ruleset_${base}`;
};

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function RulesetBuilderPage({ slug }: { slug: string }) {
  const isNew = slug === "new";
  const navigate = useNavigate();
  const templateSlug = isNew ? hashQuery().get("template") : null;
  const { data: existing, error: loadError } = useApi(["ruleset", slug], () => rulesets.get(slug), {
    enabled: !isNew,
  });
  const { data: templateList } = useApi(["ruleset-templates"], () => rulesets.templates(), {
    enabled: !!templateSlug,
  });
  const { data: listList } = useApi(["lists", "all"], () => listApi.list({ limit: 500 }));
  const { data: taken } = useApi(
    ["rulesets", "slugs"],
    async () => [
      ...(await rulesets.list({ limit: 500 })).rulesets.map((r) => r.slug),
      ...(await rulesets.list({ archived: true, limit: 500 })).rulesets.map((r) => r.slug),
    ],
    { enabled: isNew },
  );
  const listSlugs = useMemo(() => listList?.lists.map((l) => l.slug) ?? [], [listList]);

  const { draft, saved, dirty, canUndo, canRedo, change, undo, redo, reset } = useWorkflowDraft<Draft>(BLANK);
  const [server, setServer] = useState<ServerState | null>(null);
  const [serverSettings, setServerSettings] = useState<Record<string, unknown>>({});
  const [panel, setPanel] = useState<Panel>({ kind: "select", at: "start" });
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [testRun, setTestRun] = useState<RulesetTestRun | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const loaded = useRef(false);
  const leaving = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    if (existing) {
      loaded.current = true;
      reset(draftOf(existing));
      setServer(serverOf(existing));
      setServerSettings(existing.settings);
      setPanel(
        existing.definition.rules.length || existing.draft?.rules.length ? null : { kind: "select", at: "start" },
      );
    } else if (isNew && (!templateSlug || templateList)) {
      loaded.current = true;
      const template = templateList?.templates.find((t) => t.slug === templateSlug);
      if (template)
        change({
          slug: template.slug,
          name: template.name,
          description: template.description ?? "",
          settings: {},
          definition: structuredClone(template.definition),
        });
    }
  }, [existing, isNew, templateSlug, templateList, reset, change]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.bad ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !leaving.current && dirty && currentLocation.pathname !== nextLocation.pathname,
  );
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

  const definition = draft.definition;
  const rules = definition.rules;
  const archived = server?.status === "archived";
  const editable = !archived;

  const slugProblem = isNew
    ? !draft.slug
      ? "Name the ruleset."
      : rulesetSlugProblem(draft.slug)
        ? `The slug ${rulesetSlugProblem(draft.slug)}.`
        : taken?.includes(draft.slug)
          ? `Another ruleset has the slug "${draft.slug}". Choose another one.`
          : null
    : null;
  const problems = useMemo(() => {
    const map = new Map<string, string[]>();
    const add = (at: string, message: string) => map.set(at, [...(map.get(at) ?? []), message]);
    for (const p of validateRuleset(definition)) add(problemPlace(p), problemText(p));
    if (rules.length === 0) add("ruleset", "Add at least one rule.");
    if (!draft.name.trim()) add("ruleset", "Name the ruleset.");
    if (slugProblem) add("start", slugProblem);
    for (const p of serverProblems) add(problemPlace(p), problemText(p));
    for (const [at, list] of map) map.set(at, [...new Set(list)]);
    return map;
  }, [definition, rules, draft.name, slugProblem, serverProblems]);
  const problemCount = [...problems.values()].reduce((n, list) => n + list.length, 0);

  const edit = useCallback(
    (next: (d: Draft) => Draft, tag?: string) => {
      setServerProblems([]);
      change(next, tag);
    },
    [change],
  );
  const editDefinition = (next: (d: RulesetDefinition) => RulesetDefinition, tag?: string) =>
    edit((d) => ({ ...d, definition: next(d.definition) }), tag);
  const setRules = (next: (rules: RulesetRule[]) => RulesetRule[], tag?: string) =>
    editDefinition((d) => ({ ...d, rules: next(d.rules) }), tag);

  const inputNames = new Set(definition.inputs.map((i) => i.name));
  const addInputs = (d: RulesetDefinition, names: string[]): RulesetDefinition => {
    const have = new Set(d.inputs.map((i) => i.name));
    const more = names.flatMap((name) => {
      const found = !have.has(name) && catalogInput(name);
      return found ? [fromCatalog(found)] : [];
    });
    return more.length ? { ...d, inputs: [...d.inputs, ...more] } : d;
  };
  /** A rule that reads a catalog input the ruleset does not declare yet declares it. */
  const changeRule = (rule: RulesetRule, tag?: string) =>
    editDefinition(
      (d) =>
        addInputs(
          { ...d, rules: d.rules.map((r) => (r.id === rule.id ? rule : r)) },
          [...rule.when.matchAll(/\binput\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!),
        ),
      tag,
    );

  const addRule = () => {
    const rule = newRule(rules);
    setRules((list) => [...list, rule]);
    setPanel({ kind: "select", at: `rule:${rule.id}` });
  };
  const moveRule = (id: string, by: -1 | 1) =>
    setRules((list) => {
      const i = list.findIndex((r) => r.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const duplicateRule = (id: string) => {
    const at = rules.findIndex((r) => r.id === id);
    if (at < 0) return;
    const copy = copyRule(rules[at]!, rules);
    setRules((list) => [...list.slice(0, at + 1), copy, ...list.slice(at + 1)]);
    setPanel({ kind: "select", at: `rule:${copy.id}` });
  };
  const deleteRule = (id: string) => {
    const rule = rules.find((r) => r.id === id);
    if (!rule) return;
    editDefinition((d) => ({
      ...d,
      rules: d.rules.filter((r) => r.id !== id),
      tests: d.tests.map((t) => (t.rule === id ? (({ rule: _r, ...rest }) => rest)(t) : t)),
    }));
    setPanel(null);
    setNotice({ text: `Deleted "${rule.name}". Undo brings it back.` });
  };
  const renameRule = (from: string, to: string): string | null => {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(to)) return "Letters, digits and _, not first a digit.";
    if (rules.some((r) => r.id === to)) return `Another rule has the id "${to}".`;
    editDefinition((d) => ({
      ...d,
      rules: d.rules.map((r) => (r.id === from ? { ...r, id: to } : r)),
      tests: d.tests.map((t) => (t.rule === from ? { ...t, rule: to } : t)),
    }));
    setPanel({ kind: "select", at: `rule:${to}` });
    return null;
  };

  const failed = (e: unknown, text: string) => {
    const message = e instanceof Error ? e.message : String(e);
    setServerProblems(message.split("; "));
    setNotice({ text, bad: true });
  };

  const ref = server?.slug ?? draft.slug;

  const save = async () => {
    if (slugProblem) return setNotice({ text: slugProblem, bad: true });
    if (!draft.name.trim()) return setNotice({ text: "Name the ruleset.", bad: true });
    setBusy(true);
    try {
      let saved = await rulesets.saveDraft(ref, {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        definition,
      });
      if (JSON.stringify(draft.settings) !== JSON.stringify(serverSettings))
        saved = await rulesets.update(saved.slug, { settings: draft.settings });
      reset(draftOf(saved));
      setServer(serverOf(saved));
      setServerSettings(saved.settings);
      setNotice({
        text: saved.draft || saved.version === 0 ? "Saved as a draft. Publish it to make it live." : "Saved.",
      });
      if (isNew) {
        leaving.current = true;
        navigate(`/settings/rulesets/${encodeURIComponent(saved.slug)}`, { replace: true });
      }
    } catch (e) {
      failed(e, "The server did not save it.");
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (problemCount > 0)
      return setNotice({ text: "Fix the problems first: the cards with a ! show them.", bad: true });
    setBusy(true);
    try {
      const published = await rulesets.publish(ref);
      reset(draftOf(published));
      setServer(serverOf(published));
      setNotice({ text: `Published as version ${published.version}.` });
    } catch (e) {
      failed(e, "The server did not publish it. The problems are on the cards.");
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setServerProblems([]);
    if (dirty) {
      if (window.confirm("Discard the changes since the last save?")) reset(saved);
      return;
    }
    if (!server || !window.confirm(`Discard the draft and go back to version ${server.version}?`)) return;
    try {
      const live = await rulesets.discardDraft(ref);
      reset(draftOf(live));
      setServer(serverOf(live));
      setPanel(null);
    } catch (e) {
      failed(e, "The draft was not discarded.");
    }
  };

  const setArchived = async (archive: boolean) => {
    setMenuOpen(false);
    if (archive && !window.confirm(`Archive "${draft.name}"? Its versions stay, and it can be restored.`)) return;
    try {
      const changed = archive ? await rulesets.archive(ref) : await rulesets.restore(ref);
      setServer(serverOf(changed));
      if (archive) {
        leaving.current = true;
        navigate("/settings/rulesets");
      } else setNotice({ text: "Restored." });
    } catch (e) {
      failed(e, e instanceof Error ? e.message : String(e));
    }
  };

  const test = async (input?: Record<string, unknown>) => {
    setBusy(true);
    try {
      setTestRun(await rulesets.test(definition, input));
    } catch (e) {
      setTestRun({ problems: [], tests: [], error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
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
      } else if (
        (event.key === "Delete" || event.key === "Backspace") &&
        panel?.kind === "select" &&
        panel.at.startsWith("rule:") &&
        editable
      ) {
        event.preventDefault();
        deleteRule(panel.at.slice(5));
      } else if (event.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (loadError) return <Failure message={loadError.message} />;
  if (!isNew && !existing) return <Loading />;

  const selected: Selection = panel?.kind === "select" ? panel.at : null;
  const selectedRuleId = selected?.startsWith("rule:") ? selected.slice(5) : null;
  const selectedIndex = selectedRuleId ? rules.findIndex((r) => r.id === selectedRuleId) : -1;
  const selectedRule = selectedIndex >= 0 ? rules[selectedIndex] : undefined;
  const rulesetProblems = problems.get("ruleset") ?? [];

  return (
    <div className="rs-builder">
      <header className="rs-bar">
        <a className="rs-back" href={href("settings", "rulesets")} title="All rulesets">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m12 4-6 6 6 6" />
          </svg>
          Rulesets
        </a>
        <span className="rs-bar-name">
          <input
            className="wf-title-input big"
            placeholder="Name the ruleset"
            aria-label="Ruleset name"
            value={draft.name}
            disabled={!editable}
            onChange={(e) => {
              const name = e.target.value;
              edit((d) => ({ ...d, name, ...(isNew ? { slug: slugFromName(name) } : {}) }), "name");
            }}
          />
          {draft.slug && <span className="mono muted rs-slug">{draft.slug}</span>}
        </span>
        <span className="rs-bar-state">
          {dirty ? (
            <span className="wf-draft">Unsaved changes</span>
          ) : archived ? (
            <span className="chip">Archived</span>
          ) : server?.hasDraft ? (
            <span className="wf-draft">Draft</span>
          ) : server ? (
            <span className="chip accent">Version {server.version}</span>
          ) : null}
          {server && server.version > 0 && (dirty || server.hasDraft) && (
            <span className="chip">Live: version {server.version}</span>
          )}
          {problemCount > 0 && (
            <button
              type="button"
              className="wf-problem-count"
              onClick={() => {
                const first = [...problems.keys()].find((k) => k !== "ruleset");
                if (first === "tests") setPanel({ kind: "test" });
                else if (first) setPanel({ kind: "select", at: first as NonNullable<Selection> });
                else setNotice({ text: rulesetProblems[0] ?? "", bad: true });
              }}
            >
              {problemCount} {problemCount === 1 ? "problem" : "problems"}
            </button>
          )}
        </span>
        <span className="rs-bar-tools">
          {editable && (
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
              <button type="button" className="btn" onClick={addRule}>
                + Add rule
              </button>
            </>
          )}
          <button
            type="button"
            className={`btn ${catalogOpen ? "on" : ""}`}
            onClick={() => setCatalogOpen(!catalogOpen)}
            title="Standard inputs that the templates use"
          >
            Catalog
          </button>
          <button
            type="button"
            className={`btn ${panel?.kind === "test" ? "on" : ""}`}
            onClick={() => setPanel(panel?.kind === "test" ? null : { kind: "test" })}
          >
            Test
          </button>
          {editable && (dirty || (!!server?.hasDraft && server.version > 0)) && (
            <button type="button" className="btn" onClick={() => void discard()}>
              Discard
            </button>
          )}
          {archived ? (
            <button type="button" className="btn primary" onClick={() => void setArchived(false)}>
              Restore
            </button>
          ) : dirty || !server ? (
            <button
              type="button"
              className="btn primary"
              disabled={busy || !!slugProblem || !draft.name.trim()}
              title={slugProblem ?? "Save the changes as a draft (⌘S)"}
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
                    : "Run the tests, then make the draft the live version"
              }
              onClick={() => void publish()}
            >
              {busy ? "Publishing…" : "Publish"}
            </button>
          )}
          {server && !archived && (
            <span className="rs-menu-wrap">
              <button
                type="button"
                className="btn wf-icon-btn"
                aria-label="More"
                onClick={(e) => (e.stopPropagation(), setMenuOpen(!menuOpen))}
              >
                ⋯
              </button>
              {menuOpen && (
                <div className="rs-menu end" role="menu" onMouseLeave={() => setMenuOpen(false)}>
                  <button type="button" className="danger" onClick={() => void setArchived(true)}>
                    Archive
                  </button>
                </div>
              )}
            </span>
          )}
        </span>
      </header>

      <div
        className={`wf-stage rs-stage ${panel ? "with-panel" : ""} ${catalogOpen && editable ? "with-catalog" : ""}`}
      >
        {catalogOpen && editable && (
          <InputCatalog
            added={inputNames}
            onAdd={(i) => {
              editDefinition((d) => addInputs(d, [i.name]));
              setNotice({ text: `Added the input ${i.name}. Rules read it as input.${i.name}.` });
            }}
            onClose={() => setCatalogOpen(false)}
          />
        )}
        <RulesetCanvas
          definition={definition}
          editable={editable}
          selected={selected}
          problems={problems}
          result={panel?.kind === "test" ? testRun?.result : undefined}
          onSelect={(at) => setPanel(at ? { kind: "select", at } : null)}
          onAdd={addRule}
          onMove={moveRule}
          onDuplicate={duplicateRule}
          onDelete={deleteRule}
        />
        {notice && <div className={`wf-notice ${notice.bad ? "bad" : ""}`}>{notice.text}</div>}
        {rulesetProblems.length > 0 && serverProblems.length > 0 && (
          <div className="wf-notice bad top">{rulesetProblems.join(" ")}</div>
        )}
        {panel && (
          <aside className="wf-side">
            {panel.kind === "test" && (
              <TestPanel
                definition={definition}
                busy={busy}
                run={testRun}
                problems={problems.get("tests") ?? []}
                onRun={(input) => void test(input)}
                onTests={(tests) => editDefinition((d) => ({ ...d, tests }))}
                onClose={() => setPanel(null)}
              />
            )}
            {selected === "start" && (
              <StartSettings
                slug={draft.slug}
                isNew={isNew}
                description={draft.description}
                inputs={definition.inputs as WorkflowInput[]}
                settings={draft.settings}
                problems={problems.get("start") ?? []}
                onSlug={(slug) => edit((d) => ({ ...d, slug }), "slug")}
                onDescription={(description) => edit((d) => ({ ...d, description }), "description")}
                onInputs={(inputs) => editDefinition((d) => ({ ...d, inputs: inputs as RulesetInput[] }), "inputs")}
                onSettings={(settings) => edit((d) => ({ ...d, settings }), "settings")}
                onClose={() => setPanel(null)}
              />
            )}
            {selected === "default" && (
              <DefaultSettings
                fallback={definition.default}
                problems={problems.get("default") ?? []}
                onChange={(fallback) => editDefinition((d) => ({ ...d, default: fallback }), "default")}
                onClose={() => setPanel(null)}
              />
            )}
            {selectedRule && (
              <RuleSettings
                key={selectedRule.id}
                rule={selectedRule}
                index={selectedIndex}
                count={rules.length}
                inputs={[
                  ...definition.inputs.map((i) => i.name),
                  ...INPUT_CATALOG.map((i) => i.name).filter((n) => !inputNames.has(n)),
                ]}
                lists={listSlugs}
                problems={problems.get(`rule:${selectedRule.id}`) ?? []}
                onChange={changeRule}
                onRename={(to) => renameRule(selectedRule.id, to)}
                onMove={(by) => moveRule(selectedRule.id, by)}
                onDuplicate={() => duplicateRule(selectedRule.id)}
                onDelete={() => deleteRule(selectedRule.id)}
                onClose={() => setPanel(null)}
              />
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
