import { Outlet } from "react-router";
import { WorkspaceMenu } from "../components/shell/WorkspaceMenu";
import { PageBoundary } from "../components/ui/states";
import { href, lastAppRoute } from "../lib/route";
import { useRoute } from "../hooks/useRoute";
import { useShellChrome } from "../hooks/useShellChrome";
import { useWorkspace } from "../hooks/useWorkspace";

export const SETTINGS_TABS: { title: string; items: { id: string; label: string }[] }[] = [
  {
    title: "Account",
    items: [
      { id: "profile", label: "Profile" },
      { id: "preferences", label: "Preferences" },
    ],
  },
  {
    title: "Workspace",
    items: [
      { id: "general", label: "General" },
      { id: "members", label: "Members" },
      { id: "environments", label: "Environments" },
      { id: "models", label: "Models" },
      { id: "usage", label: "Usage" },
      { id: "activity", label: "Activity" },
    ],
  },
  {
    title: "Developer",
    items: [
      { id: "keys", label: "API keys" },
      { id: "mcp", label: "MCP" },
      { id: "webhooks", label: "Webhooks" },
      { id: "jobs", label: "Jobs" },
    ],
  },
];

export function SettingsLayout() {
  const { session, workspace, environment, onChooseEnvironment, onChoose, onSignOut } = useWorkspace();
  const route = useRoute();
  const chrome = useShellChrome(route, {
    session,
    workspaceId: workspace.id,
    environmentId: environment.id,
    onChooseEnvironment,
    onChoose,
    onSignOut,
  });
  return (
    <div className={`shell ${chrome.menuOpen ? "menu-open" : ""}`}>
      <aside className="sidebar" aria-label="Settings menu" onClick={chrome.closeOnLink}>
        <WorkspaceMenu
          session={session}
          workspaceId={workspace.id}
          environment={environment}
          onChooseEnvironment={onChooseEnvironment}
          onChoose={onChoose}
          onSearch={chrome.search}
        />
        <a className="back" href={href(...lastAppRoute())}>
          <svg viewBox="0 0 20 20">
            <path d="m12 4-6 6 6 6" />
          </svg>
          Back to dashboard
        </a>
        <div className="side-nav">
          {SETTINGS_TABS.map((group) => (
            <nav className="nav" key={group.title}>
              <div className="nav-label">{group.title}</div>
              {group.items.map((item) => (
                <a key={item.id} href={href("settings", item.id)} className={route[1] === item.id ? "active" : ""}>
                  {item.label}
                </a>
              ))}
            </nav>
          ))}
        </div>
      </aside>
      {chrome.backdrop}
      <div className="frame">
        <header className="topbar settings-bar">
          {chrome.menuButton}
          <span className="trail">
            <span className="here">Settings</span>
            <span> · {environment.name}</span>
          </span>
        </header>
        <main className="frame-scroll">
          <PageBoundary key={route.join("/")}>
            <div className="settings-main">
              <Outlet />
            </div>
          </PageBoundary>
        </main>
      </div>
      {chrome.palette}
    </div>
  );
}
