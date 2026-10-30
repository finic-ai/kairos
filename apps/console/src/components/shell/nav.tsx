export const ICONS = {
  overview: (
    <>
      <rect x="3" y="3" width="6" height="8" rx="1.2" />
      <rect x="11" y="3" width="6" height="5" rx="1.2" />
      <rect x="3" y="13" width="6" height="4" rx="1.2" />
      <rect x="11" y="10" width="6" height="7" rx="1.2" />
    </>
  ),
  "get-started": (
    <path d="M5 15 3.5 16.5M10.5 13.5 6.5 9.5c1-3.500 4-6 9-6 0 5-2.5 8-6 9zM6.5 9.5l-3 .5 2-2.5M10.5 13.5l-.5 3 2.5-2M13 7h.01" />
  ),
  dashboards: <path d="M3.5 16.5v-6M8 16.5v-12M12.5 16.5v-8M17 16.5v-4" />,
  decisions: <path d="M3 5h14M3 10h14M3 15h9" />,
  queues: <path d="M3 11h4l1.5 2h3L13 11h4M3 11l2-6h10l2 6v5H3z" />,
  sessions: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.8 1.8" />
    </>
  ),
  entities: (
    <>
      <circle cx="5" cy="10" r="2.2" />
      <circle cx="15" cy="5" r="2.2" />
      <circle cx="15" cy="15" r="2.2" />
      <path d="m7 9 6-3M7 11l6 3" />
    </>
  ),
  actions: <path d="M11 2.5 4.5 11.5H10l-1 6 6.5-9H10z" />,
  workflows: (
    <>
      <circle cx="5" cy="5" r="2" />
      <circle cx="5" cy="15" r="2" />
      <circle cx="15" cy="10" r="2" />
      <path d="M5 7v6M6.8 5.9 13.2 9M6.8 14.1 13.2 11" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
    </>
  ),
};

export const GROUPS: { id: keyof typeof ICONS; label: string }[][] = [
  [
    { id: "overview", label: "Overview" },
    { id: "dashboards", label: "Dashboards" },
    { id: "decisions", label: "Decisions" },
    { id: "queues", label: "Queues" },
    { id: "sessions", label: "Sessions" },
    { id: "entities", label: "Entities" },
  ],
  [
    { id: "actions", label: "Actions" },
    { id: "workflows", label: "Workflows" },
  ],
];

export const LABEL: Record<string, string> = {
  "entity-types": "Entities",
  "get-started": "Get started",
  overview: "Overview",
  dashboards: "Dashboards",
  decisions: "Decisions",
  queues: "Queues",
  cases: "Case",
  sessions: "Sessions",
  entities: "Entities",
  actions: "Actions",
  workflows: "Workflows",
  "workflow-runs": "Workflow run",
  settings: "Settings",
};
