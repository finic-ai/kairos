import { Fragment, useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router";
import { EnvironmentMenu } from "../components/shell/EnvironmentMenu";
import { GROUPS, ICONS, LABEL } from "../components/shell/nav";
import { UserMenu } from "../components/shell/UserMenu";
import { WorkspaceMenu } from "../components/shell/WorkspaceMenu";
import { PageBoundary } from "../components/ui/states";
import { entityName, entityNames } from "../lib/format";
import { setStartHidden, startHidden } from "../lib/getStarted";
import { href, rememberAppRoute } from "../lib/route";
import { useQueues, useStats } from "../hooks/useApi";
import { useRoute } from "../hooks/useRoute";
import { useShellChrome } from "../hooks/useShellChrome";
import type { StartContext } from "../hooks/useStartContext";
import { useStartProgress } from "../hooks/useStartProgress";
import { useWorkspace } from "../hooks/useWorkspace";

/** The console build publishes the documentation at /docs; VITE_KAIROS_DOCS_URL points the link somewhere else. */
const DOCS_URL =
  String((import.meta as { env?: Record<string, string> }).env?.VITE_KAIROS_DOCS_URL ?? "").trim() || "/docs";

/**
 * For work on the "Get started" page: with VITE_KAIROS_SHOW_GET_STARTED=1 in the environment of
 * the console, the page is always in the sidebar and is always the first page, also when every
 * step is done or the person removed it.
 */
const ALWAYS_START = ["1", "true"].includes(
  String((import.meta as { env?: Record<string, string> }).env?.VITE_KAIROS_SHOW_GET_STARTED ?? ""),
);

export function DashboardLayout() {
  const { session, workspace, environment, onChooseEnvironment, onChoose, onSignOut } = useWorkspace();
  const route = useRoute();
  const navigate = useNavigate();
  const page = route[0] ?? "";
  useEffect(() => {
    if (route.length > 0) rememberAppRoute(route);
  }, [route]);

  const progress = useStartProgress(workspace.id, 8000);
  const [startOff, setStartOff] = useState(() => startHidden(environment.id));
  const hideStart = (off: boolean) => (setStartHidden(environment.id, off), setStartOff(off));
  const start = {
    show: ALWAYS_START || (!startOff && progress.checked && progress.count < progress.total),
    count: progress.count,
    total: progress.total,
    onRemove: () => (hideStart(true), page === "get-started" && navigate("/overview")),
  };
  const outlet: StartContext = {
    checked: ALWAYS_START || progress.checked,
    shown: start.show,
    hidden: !start.show && startOff,
    onShow: () => hideStart(false),
  };

  const chrome = useShellChrome(route, {
    session,
    workspaceId: workspace.id,
    environmentId: environment.id,
    onChooseEnvironment,
    onChoose,
    onSignOut,
  });
  const { data: stats, error } = useStats(8000);
  const { data: queueList } = useQueues(15_000);
  const mine = queueList?.queues.reduce((n, q) => n + (q.counts?.mine ?? 0), 0);
  const counts: Record<string, number | undefined> = { decisions: stats?.decisions, actions: stats?.actions };
  const trail = [page, ...route.slice(1)];
  // The workflow builder puts its name in the trail and its buttons in the bar, as a dashboard does.
  const builder = page === "workflows" && route.length === 2;
  // A workflow's runs and experiments are tabs beside its builder, with the same trail.
  const workflowTab = page === "workflows" && route.length === 3 && (route[2] === "runs" || route[2] === "experiments");
  // A queue, its editor and a case name themselves in the trail, not by their ids.
  const queueTrail = (page === "queues" && route.length > 1) || page === "cases";
  const named = (i: number) =>
    i === 1 && (page === "entities" || page === "entity-types" || page === "actions" || page === "workflows");
  const keyed = page === "actions" || page === "workflows";
  const crumb = (segment: string, i: number) =>
    i === 0
      ? (LABEL[segment] ?? segment)
      : keyed && i === 2 && segment === "edit"
        ? "Edit"
        : page === "workflows" && i === 2 && segment === "runs"
          ? "Runs"
          : page === "workflows" && i === 2 && segment === "experiments"
            ? "Experiments"
            : !named(i)
              ? segment
              : segment === "new"
                ? "New"
                : keyed
                  ? entityName(segment)
                  : entityNames(segment);

  return (
    <div className={`shell ${chrome.menuOpen ? "menu-open" : ""}`}>
      <aside className="sidebar" aria-label="Menu" onClick={chrome.closeOnLink}>
        <WorkspaceMenu
          session={session}
          workspaceId={workspace.id}
          environment={environment}
          onChooseEnvironment={onChooseEnvironment}
          onChoose={onChoose}
          onSearch={chrome.search}
        />
        <div className="side-nav">
          {start.show && (
            <nav className="nav">
              <a
                href={href("get-started")}
                className={`start-link ${page === "get-started" ? "active" : ""}`}
                title={`${start.count} of ${start.total} steps done`}
              >
                <span className="ring">
                  <svg viewBox="0 0 28 28" aria-hidden>
                    <circle className="track" cx="14" cy="14" r="12" />
                    <circle
                      className="arc"
                      cx="14"
                      cy="14"
                      r="12"
                      strokeDasharray={2 * Math.PI * 12}
                      strokeDashoffset={2 * Math.PI * 12 * (1 - start.count / start.total)}
                    />
                  </svg>
                  <svg className="glyph" viewBox="0 0 20 20">
                    {ICONS["get-started"]}
                  </svg>
                </span>
                Get started
                <span className="count">
                  {start.count}/{start.total}
                </span>
                <button
                  className="nav-close"
                  aria-label="Remove Get started from the sidebar"
                  title="Remove from the sidebar"
                  onClick={(e) => (e.preventDefault(), e.stopPropagation(), start.onRemove())}
                >
                  ×
                </button>
              </a>
            </nav>
          )}
          {GROUPS.map((group, i) => (
            <nav className="nav" key={i}>
              {group.map((item) => (
                <a
                  key={item.id}
                  href={href(item.id)}
                  className={
                    page === item.id ||
                    (item.id === "entities" && page === "entity-types") ||
                    (item.id === "queues" && page === "cases")
                      ? "active"
                      : ""
                  }
                >
                  <svg viewBox="0 0 20 20">{ICONS[item.id]}</svg>
                  {item.label}
                  {counts[item.id] !== undefined && <span className="count">{counts[item.id]!.toLocaleString()}</span>}
                  {item.id === "queues" && !!mine && (
                    <span className="count mine" title={`${mine.toLocaleString()} open cases assigned to you`}>
                      {mine.toLocaleString()}
                    </span>
                  )}
                </a>
              ))}
            </nav>
          ))}
        </div>
        {DOCS_URL && (
          <div className="side-foot">
            <nav className="nav">
              <a href={DOCS_URL} target="_blank" rel="noreferrer">
                <svg viewBox="0 0 20 20">
                  <path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H15v12H5.5A1.5 1.5 0 0 0 4 16.5zM4 16.5A1.5 1.5 0 0 0 5.5 18H15v-3" />
                </svg>
                Documentation
              </a>
            </nav>
          </div>
        )}
      </aside>

      {chrome.backdrop}
      <div className="frame">
        <header className="topbar">
          {chrome.menuButton}
          <div className="trail">
            {page === "dashboards" ? (
              <>
                <span>Dashboard</span>
                <span>›</span>
                <span id="trail-slot" />
              </>
            ) : builder || workflowTab ? (
              <>
                <a href={href("workflows")}>{LABEL.workflows}</a>
                <span>›</span>
                <span id="trail-slot" className="trail-slot" />
              </>
            ) : queueTrail ? (
              <>
                <a href={href("queues")}>{LABEL.queues}</a>
                <span>›</span>
                <span id="trail-slot" className="trail-slot named" />
              </>
            ) : (
              trail.map((segment, i) => (
                <Fragment key={i}>
                  {i > 0 && <span>›</span>}
                  {i < trail.length - 1 ? (
                    <a
                      href={
                        i === 0 && page === "entity-types"
                          ? href("entities")
                          : page === "entity-types"
                            ? href("entities", segment)
                            : href(...trail.slice(0, i + 1))
                      }
                    >
                      {crumb(segment, i)}
                    </a>
                  ) : (
                    <span className={`here ${i > 0 && !named(i) && !(keyed && i === 2) ? "mono" : ""}`}>
                      {crumb(segment, i)}
                    </span>
                  )}
                </Fragment>
              ))
            )}
          </div>
          <div className="right">
            {/* A workflow belongs to one environment: the builder does not switch it. */}
            {!builder && (
              <EnvironmentMenu
                environments={workspace.environments}
                environment={environment}
                onChoose={onChooseEnvironment}
              />
            )}
            <span id="topbar-slot" className="topbar-slot" />
            {stats && page !== "dashboards" && !builder && (
              <span className="counts">{stats.events.toLocaleString()} events</span>
            )}
            {error && (
              <span className="status down">
                <i />
                API unreachable
              </span>
            )}
            {!builder && <UserMenu session={session} onSignOut={onSignOut} />}
          </div>
        </header>
        <main className="frame-scroll">
          <div className="main">
            <PageBoundary key={route.join("/")}>
              <Outlet context={outlet} />
            </PageBoundary>
          </div>
        </main>
      </div>
      {chrome.palette}
    </div>
  );
}
