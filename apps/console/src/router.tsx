import type { ComponentType } from "react";
import { createHashRouter, Navigate, useNavigate, useParams } from "react-router";
import { App } from "./App";
import { Empty } from "./components/ui/states";
import { DashboardLayout } from "./layouts/DashboardLayout";
import { SettingsLayout } from "./layouts/SettingsLayout";
import { go, lastAppRoute } from "./lib/route";
import type { WorkspaceState } from "./lib/workspace";
import { useStartContext } from "./hooks/useStartContext";
import { useWorkspace } from "./hooks/useWorkspace";
import { ActionEditorPage } from "./pages/actions/ActionEditorPage";
import { ActionPage } from "./pages/actions/ActionPage";
import { ActionsPage } from "./pages/actions/ActionsPage";
import { Dashboards } from "./pages/Dashboards";
import { DecisionPage } from "./pages/decisions/DecisionPage";
import { DecisionsPage } from "./pages/decisions/DecisionsPage";
import { EntityListPage } from "./pages/entities/EntityListPage";
import { EntityPage } from "./pages/entities/EntityPage";
import { EntityTypeEditorPage } from "./pages/entities/EntityTypeEditorPage";
import { EntityTypesPage } from "./pages/entities/EntityTypesPage";
import { GetStartedPage } from "./pages/get-started/GetStartedPage";
import { OverviewPage } from "./pages/overview/OverviewPage";
import { SessionPage } from "./pages/sessions/SessionPage";
import { SessionsPage } from "./pages/sessions/SessionsPage";
import { EventsPage } from "./pages/events/EventsPage";
import { ActivityPage } from "./pages/settings/ActivityPage";
import { IntegrationsPage } from "./pages/settings/integrations/IntegrationsPage";
import { EnvironmentsPage } from "./pages/settings/EnvironmentsPage";
import { GeneralPage } from "./pages/settings/GeneralPage";
import { JobsPage } from "./pages/settings/JobsPage";
import { KeysPage } from "./pages/settings/KeysPage";
import { McpPage } from "./pages/settings/McpPage";
import { MembersPage } from "./pages/settings/MembersPage";
import { PreferencesPage } from "./pages/settings/PreferencesPage";
import { ProfilePage } from "./pages/settings/ProfilePage";
import { UsagePage } from "./pages/settings/UsagePage";
import type { SettingsPageProps } from "./pages/settings/types";
import { WebhooksPage } from "./pages/settings/webhooks/Webhooks";
import { CasePage } from "./pages/queues/CasePage";
import { CaseViewEditorPage } from "./pages/queues/CaseViewEditorPage";
import { QueueEditorPage } from "./pages/queues/QueueEditorPage";
import { QueuePage } from "./pages/queues/QueuePage";
import { QueuesPage } from "./pages/queues/QueuesPage";
import { WorkflowBuilderPage } from "./pages/workflows/WorkflowBuilderPage";
import { WorkflowExperimentPage } from "./pages/workflows/WorkflowExperimentPage";
import { WorkflowExperimentsPage } from "./pages/workflows/WorkflowExperimentsPage";
import { WorkflowRunPage } from "./pages/workflows/WorkflowRunPage";
import { WorkflowRunsPage } from "./pages/workflows/WorkflowRunsPage";
import { WorkflowsPage } from "./pages/workflows/WorkflowsPage";
import { ModelPage } from "./pages/settings/models/ModelPage";
import { ModelsPage } from "./pages/settings/models/ModelsPage";
import { ListPage } from "./pages/settings/lists/ListPage";
import { ListsPage } from "./pages/settings/lists/ListsPage";
import { RulesetBuilderPage } from "./pages/settings/rulesets/RulesetBuilderPage";
import { RulesetsPage } from "./pages/settings/rulesets/RulesetsPage";
import { NewWorkspacePage } from "./pages/workspaces/NewWorkspacePage";

function FirstPage() {
  const start = useStartContext();
  // Until the steps are checked, the first page is not known: show nothing, not the wrong page.
  if (!start.checked) return <div className="empty muted">Loading…</div>;
  return <Navigate to={start.shown ? "/get-started" : "/overview"} replace />;
}

function GetStartedRoute() {
  const { workspace, session } = useWorkspace();
  const start = useStartContext();
  return <GetStartedPage workspace={workspace} session={session} hidden={start.hidden} onShow={start.onShow} />;
}

function DashboardsRoute() {
  return <Dashboards id={useParams().id} />;
}

function DecisionRoute() {
  return <DecisionPage id={useParams().id!} />;
}

function SessionRoute() {
  return <SessionPage id={useParams().id!} />;
}

function ActionRoute() {
  const { name } = useParams();
  return <ActionPage key={name} name={name!} />;
}

function ActionEditorRoute() {
  const name = useParams().name ?? "new";
  return <ActionEditorPage key={name} name={name} />;
}

function EntityListRoute() {
  const { type } = useParams();
  return <EntityListPage key={type} type={type!} />;
}

function EntityRoute() {
  const { type, id } = useParams();
  return <EntityPage key={`${type}/${id}`} type={type!} id={id!} />;
}

function EntityTypeEditorRoute() {
  const type = useParams().type ?? "new";
  return <EntityTypeEditorPage key={type} type={type} />;
}

const settingsProps = (state: WorkspaceState): SettingsPageProps => ({
  environment: state.environment,
  onChooseEnvironment: state.onChooseEnvironment,
  workspace: state.workspace,
  session: state.session,
  onChange: state.onRefresh,
  onSignedOut: state.onSignedOut,
});

const settingsPage = (Page: ComponentType<SettingsPageProps>) =>
  function SettingsRoute() {
    return <Page {...settingsProps(useWorkspace())} />;
  };
const ProfileRoute = settingsPage(ProfilePage);
const GeneralRoute = settingsPage(GeneralPage);
const MembersRoute = settingsPage(MembersPage);
const McpRoute = settingsPage(McpPage);
const UsageRoute = settingsPage(UsagePage);
const JobsRoute = settingsPage(JobsPage);
const ActivityRoute = settingsPage(ActivityPage);

function KeysRoute() {
  return <KeysPage {...settingsProps(useWorkspace())} id={useParams().id} />;
}

function IntegrationsRoute() {
  return <IntegrationsPage {...settingsProps(useWorkspace())} id={useParams().id} />;
}

function EnvironmentsRoute() {
  const { workspace, environment, onRefresh, onChooseEnvironment } = useWorkspace();
  return (
    <EnvironmentsPage workspace={workspace} current={environment} onChange={onRefresh} onChoose={onChooseEnvironment} />
  );
}

function WebhooksRoute() {
  return <WebhooksPage workspace={useWorkspace().workspace} id={useParams().id} />;
}

function QueueRoute() {
  const { id } = useParams();
  return <QueuePage key={id} id={id!} />;
}

function QueueEditorRoute() {
  const id = useParams().id ?? "new";
  return <QueueEditorPage key={id} id={id} />;
}

function CaseViewEditorRoute() {
  const { id } = useParams();
  return <CaseViewEditorPage key={id} id={id!} />;
}

function CaseRoute() {
  const { id } = useParams();
  return <CasePage key={id} id={id!} />;
}

/** The links of the old workflow page and its editor open the builder. */
function WorkflowEditRoute() {
  return <Navigate to={`/workflows/${encodeURIComponent(useParams().name!)}`} replace />;
}

function WorkflowRunsRoute() {
  const { name } = useParams();
  return <WorkflowRunsPage key={name} name={name!} />;
}

function WorkflowExperimentsRoute() {
  const { name } = useParams();
  return <WorkflowExperimentsPage key={name} name={name!} />;
}

function WorkflowExperimentRoute() {
  const { name, id } = useParams();
  return <WorkflowExperimentPage key={id} name={name!} id={id!} />;
}

function WorkflowBuilderRoute() {
  const name = useParams().name ?? "new";
  return <WorkflowBuilderPage key={name} name={name} />;
}

function WorkflowRunRoute() {
  const { id } = useParams();
  return <WorkflowRunPage key={id} id={id!} />;
}

function ModelRoute() {
  const { slug } = useParams();
  return <ModelPage key={slug} slug={slug!} />;
}

function ListRoute() {
  const { slug } = useParams();
  return <ListPage key={slug} slug={slug!} />;
}

function RulesetBuilderRoute() {
  const slug = useParams().slug ?? "new";
  return <RulesetBuilderPage key={slug} slug={slug} />;
}

function NewWorkspaceRoute() {
  const { onChoose, onRefresh } = useWorkspace();
  const navigate = useNavigate();
  return (
    <NewWorkspacePage
      cancel={{ label: "Cancel", onClick: () => go(...lastAppRoute()) }}
      onDone={async (id) => {
        await onRefresh();
        onChoose(id);
        navigate("/get-started");
      }}
    />
  );
}

function NotFound({ settings }: { settings?: boolean }) {
  const page = (
    <Empty title="Page not found">
      {settings ? "Choose a page from the sidebar." : "Choose a page from the menu."}
    </Empty>
  );
  return settings ? <div className="card">{page}</div> : page;
}

/** Made after the Supabase token and the sign-in error are out of the address: the router reads the address when it starts. */
export const createRouter = () =>
  createHashRouter([
    {
      element: <App />,
      children: [
        // The root route shows the invite, signed in or not.
        { path: "invite/:token", element: null },
        { path: "workspaces/new", element: <NewWorkspaceRoute /> },
        {
          path: "settings",
          element: <SettingsLayout />,
          children: [
            { index: true, element: <Navigate to="general" replace /> },
            { path: "profile", element: <ProfileRoute /> },
            { path: "preferences", element: <PreferencesPage /> },
            { path: "general", element: <GeneralRoute /> },
            { path: "members", element: <MembersRoute /> },
            { path: "environments", element: <EnvironmentsRoute /> },
            { path: "models", element: <ModelsPage /> },
            { path: "models/:slug", element: <ModelRoute /> },
            { path: "rulesets", element: <RulesetsPage /> },
            { path: "rulesets/new", element: <RulesetBuilderRoute /> },
            { path: "rulesets/:slug", element: <RulesetBuilderRoute /> },
            { path: "lists", element: <ListsPage /> },
            { path: "lists/:slug", element: <ListRoute /> },
            { path: "keys/:id?", element: <KeysRoute /> },
            { path: "integrations/:id?", element: <IntegrationsRoute /> },
            { path: "mcp", element: <McpRoute /> },
            { path: "usage", element: <UsageRoute /> },
            { path: "activity", element: <ActivityRoute /> },
            { path: "webhooks/:id?", element: <WebhooksRoute /> },
            { path: "jobs", element: <JobsRoute /> },
            { path: "*", element: <NotFound settings /> },
          ],
        },
        {
          element: <DashboardLayout />,
          children: [
            { index: true, element: <FirstPage /> },
            { path: "get-started", element: <GetStartedRoute /> },
            { path: "overview", element: <OverviewPage /> },
            { path: "dashboards/:id?", element: <DashboardsRoute /> },
            { path: "decisions", element: <DecisionsPage /> },
            { path: "decisions/:id", element: <DecisionRoute /> },
            { path: "queues", element: <QueuesPage /> },
            { path: "queues/new", element: <QueueEditorRoute /> },
            { path: "queues/:id", element: <QueueRoute /> },
            { path: "queues/:id/edit", element: <QueueEditorRoute /> },
            { path: "queues/:id/page", element: <CaseViewEditorRoute /> },
            { path: "cases/:id", element: <CaseRoute /> },
            { path: "sessions", element: <SessionsPage /> },
            { path: "sessions/:id", element: <SessionRoute /> },
            { path: "events", element: <EventsPage /> },
            { path: "actions", element: <ActionsPage /> },
            { path: "actions/new", element: <ActionEditorRoute /> },
            { path: "actions/:name", element: <ActionRoute /> },
            { path: "actions/:name/edit", element: <ActionEditorRoute /> },
            { path: "workflows", element: <WorkflowsPage /> },
            { path: "workflows/new", element: <WorkflowBuilderRoute /> },
            { path: "workflows/:name", element: <WorkflowBuilderRoute /> },
            { path: "workflows/:name/edit", element: <WorkflowEditRoute /> },
            { path: "workflows/:name/runs", element: <WorkflowRunsRoute /> },
            { path: "workflows/:name/runs/:id", element: <WorkflowRunRoute /> },
            { path: "workflows/:name/experiments", element: <WorkflowExperimentsRoute /> },
            { path: "workflows/:name/experiments/:id", element: <WorkflowExperimentRoute /> },
            { path: "workflow-runs", element: <Navigate to="/workflows" replace /> },
            { path: "workflow-runs/:id", element: <WorkflowRunRoute /> },
            { path: "entities", element: <EntityTypesPage /> },
            { path: "entities/:type", element: <EntityListRoute /> },
            { path: "entities/:type/:id", element: <EntityRoute /> },
            { path: "entity-types/:type?", element: <EntityTypeEditorRoute /> },
            // Links from before the settings had their own pages.
            { path: "members", element: <Navigate to="/settings/members" replace /> },
            { path: "keys", element: <Navigate to="/settings/keys" replace /> },
            { path: "*", element: <NotFound /> },
          ],
        },
      ],
    },
  ]);
