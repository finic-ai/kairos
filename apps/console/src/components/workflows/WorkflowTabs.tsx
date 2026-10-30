import { experiments, workflows } from "../../api/index";
import { InTopbar } from "../shell/InTopbar";
import { useApi } from "../../hooks/useApi";
import { useMedia } from "../../hooks/useMedia";
import { isPending, POLL_MS } from "../../lib/experiments";
import { href } from "../../lib/route";
import { RUN_OPEN } from "../../lib/workflows";

export type WorkflowTab = "builder" | "runs" | "experiments";

/** Below this width the tabs and the builder's buttons do not fit beside the name in the top bar. */
export const NARROW = "(max-width: 820px)";

/** The trail and the tabs of a workflow's runs or experiments page. */
export function WorkflowPageTabs({ name, label, current }: { name: string; label: string; current: WorkflowTab }) {
  const narrow = useMedia(NARROW);
  return (
    <>
      <InTopbar slot="trail-slot">
        <span className="wf-toolbar-name">
          <a className="here" href={href("workflows", name)}>
            {label}
          </a>
          {!narrow && <WorkflowTabs name={name} current={current} />}
        </span>
      </InTopbar>
      {narrow && (
        <div className="wf-page-tabs">
          <WorkflowTabs name={name} current={current} />
        </div>
      )}
    </>
  );
}

/** A workflow's builder, runs and experiments. Without `name`, the workflow was never saved and has neither. */
export function WorkflowTabs({ name, current }: { name?: string; current: WorkflowTab }) {
  const saved = !!name;
  const { data: runList } = useApi(["workflow-runs", name, 50], () => workflows.runs(name!, 50), {
    enabled: saved,
    refetchInterval: 10_000,
  });
  const { data: experimentList } = useApi(["workflow-experiments", name], () => experiments.list(name!), {
    enabled: saved,
    refetchInterval: (query) => (query.state.data?.experiments.some(isPending) ? POLL_MS : 30_000),
  });
  const open = runList?.runs.filter((r) => RUN_OPEN.includes(r.status)).length ?? 0;
  const tried = experimentList?.experiments ?? [];
  const pending = tried.filter(isPending).length;

  const tab = (id: WorkflowTab, label: string, badge?: { text: string; live: boolean; title: string }) =>
    saved || id === "builder" ? (
      <a
        key={id}
        href={id === "builder" ? href("workflows", name ?? "new") : href("workflows", name!, id)}
        className={current === id ? "on" : ""}
        aria-current={current === id ? "page" : undefined}
      >
        {label}
        {badge && (
          <span className={`count ${badge.live ? "live" : ""}`} title={badge.title}>
            {badge.text}
          </span>
        )}
      </a>
    ) : (
      <span key={id} className="off" title="Save the workflow first">
        {label}
      </span>
    );

  return (
    <nav className="seg tight wf-tabs" aria-label="Workflow">
      {tab("builder", "Builder")}
      {tab(
        "runs",
        "Runs",
        open > 0
          ? { text: String(open), live: true, title: `${open} ${open === 1 ? "run" : "runs"} in progress` }
          : undefined,
      )}
      {tab(
        "experiments",
        "Experiments",
        tried.length > 0
          ? {
              text: String(tried.length),
              live: pending > 0,
              title: pending > 0 ? `${pending} running` : `${tried.length} experiments`,
            }
          : undefined,
      )}
    </nav>
  );
}
