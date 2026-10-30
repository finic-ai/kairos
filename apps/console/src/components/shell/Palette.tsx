import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../../types/interfaces";
import { saveAppearance, saveTheme } from "../../theme";
import { actionName, entityNames } from "../../lib/format";
import { go } from "../../lib/route";
import { useActions, useEntityTypeList, useQueues } from "../../hooks/useApi";

interface Command {
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

export interface PaletteProps {
  session: Session;
  workspaceId: string;
  environmentId: string;
  onChooseEnvironment: (id: string) => void;
  onChoose: (id: string) => void;
  onSignOut: () => void;
  onClose: () => void;
}

const PAGES: [string, ...string[]][] = [
  ["Get started", "get-started"],
  ["Overview", "overview"],
  ["Dashboards", "dashboards"],
  ["Decisions", "decisions"],
  ["Entities", "entities"],
  ["Actions", "actions"],
  ["Queues", "queues"],
  ["Workflows", "workflows"],
  ["New action", "actions", "new"],
  ["New queue", "queues", "new"],
  ["Define an entity", "entity-types", "new"],
];

const SETTINGS: [string, string][] = [
  ["Profile", "profile"],
  ["Preferences", "preferences"],
  ["Settings", "general"],
  ["Members", "members"],
  ["Environments", "environments"],
  ["Models", "models"],
  ["API keys", "keys"],
  ["Webhooks", "webhooks"],
  ["Usage", "usage"],
];

export function Palette({
  session,
  workspaceId,
  environmentId,
  onChooseEnvironment,
  onChoose,
  onSignOut,
  onClose,
}: PaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const { data: actions } = useActions();
  const { data: types } = useEntityTypeList();
  const { data: queueList } = useQueues();

  const commands = useMemo<Command[]>(() => {
    const all: Command[] = [];
    const text = query.trim();
    // "user/user_42" or "user:user_42" opens that entity, and a decision id opens the decision.
    const entity = text.match(/^([\w-]+)[/:](.+)$/);
    if (entity)
      all.push({
        group: "Open",
        label: `${entity[1]} ${entity[2]}`,
        hint: "entity",
        run: () => go("entities", entity[1]!, entity[2]!),
      });
    if (/^kdec_\w+$/.test(text))
      all.push({ group: "Open", label: text, hint: "decision", run: () => go("decisions", text) });
    if (/^case_\w+$/.test(text)) all.push({ group: "Open", label: text, hint: "case", run: () => go("cases", text) });

    for (const [label, ...route] of PAGES) all.push({ group: "Go to", label, run: () => go(...route) });
    for (const action of actions?.actions ?? [])
      all.push({
        group: "Actions",
        label: actionName(action),
        hint: action.name,
        run: () => go("actions", action.name),
      });
    for (const queue of queueList?.queues ?? [])
      all.push({
        group: "Queues",
        label: queue.name,
        hint: queue.counts ? `${(queue.counts.open + queue.counts.in_review).toLocaleString()} to do` : undefined,
        run: () => go("queues", queue.id),
      });
    for (const type of types?.types ?? [])
      all.push({
        group: "Entities",
        label: entityNames(type.type),
        hint: `${type.count.toLocaleString()}`,
        run: () => go("entities", type.type),
      });
    for (const [label, tab] of SETTINGS) all.push({ group: "Settings", label, run: () => go("settings", tab) });
    for (const environment of session.workspaces.find((w) => w.id === workspaceId)?.environments ?? []) {
      if (environment.id !== environmentId)
        all.push({
          group: "Switch environment",
          label: environment.name,
          hint: environment.kind,
          run: () => onChooseEnvironment(environment.id),
        });
    }
    for (const w of session.workspaces) {
      if (w.id !== workspaceId)
        all.push({
          group: "Switch workspace",
          label: w.name,
          hint: w.role,
          run: () => (onChoose(w.id), go("overview")),
        });
    }
    for (const theme of ["light", "dark", "system"] as const)
      all.push({ group: "Theme", label: `Use the ${theme} theme`, run: () => saveTheme(theme) });
    all.push(
      { group: "Appearance", label: "Use navy and orange styling", run: () => saveAppearance("navy") },
      { group: "Appearance", label: "Use original styling", run: () => saveAppearance("classic") },
    );
    all.push({ group: "Account", label: "Sign out", run: onSignOut });

    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter(
      (c) => c.group === "Open" || words.every((word) => `${c.group} ${c.label}`.toLowerCase().includes(word)),
    );
  }, [query, actions, types, queueList, session, workspaceId, environmentId, onChooseEnvironment, onChoose, onSignOut]);

  useEffect(() => setIndex(0), [query]);
  // In braces: some browsers return a promise from scrollIntoView, and an effect must not return one.
  useEffect(() => {
    list.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") (event.preventDefault(), setIndex((i) => Math.min(i + 1, commands.length - 1)));
    else if (event.key === "ArrowUp") (event.preventDefault(), setIndex((i) => Math.max(i - 1, 0)));
    else if (event.key === "Enter") (event.preventDefault(), run(commands[index]));
    else if (event.key === "Escape") onClose();
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Command menu">
        <input
          className="palette-input"
          placeholder="Search pages, actions, queues, entities… or type user/user_42"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
        />
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {commands.length === 0 && <div className="palette-empty">Nothing matches “{query}”.</div>}
          {commands.map((command, i) => (
            <div key={`${command.group}/${command.label}`}>
              {command.group !== commands[i - 1]?.group && <div className="menu-label">{command.group}</div>}
              <button
                role="option"
                aria-selected={i === index}
                className={i === index ? "on" : ""}
                onMouseMove={() => setIndex(i)}
                onClick={() => run(command)}
              >
                <span className="grow">{command.label}</span>
                {command.hint && <small>{command.hint}</small>}
              </button>
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
          <span>
            <kbd>esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
