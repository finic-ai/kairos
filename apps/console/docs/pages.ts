/**
 * `expanded`: its children always show in the sidebar, not only on the page or a child.
 */
export type DocPage = {
  slug: string;
  title: string;
  blurb: string;
  children?: DocPage[];
  expanded?: boolean;
};
/** A named set of pages inside a group, such as Reference › Clients. It has no page of its own. */
export type DocSection = { section: string; pages: DocPage[] };
export type DocItem = DocPage | DocSection;
export type DocGroup = { heading: string; items: DocItem[] };

export const isSection = (item: DocItem): item is DocSection => "section" in item;

/** "login_failed" → "Login Failed". */
const titleOf = (type: string) =>
  type
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

const EVENTS: [string, string][] = [
  ["account_opened", "A new account was opened."],
  ["application_submitted", "An application was completed: for an account, a loan, a merchant account."],
  ["bank_transfer_requested", "A request that needs a decision."],
  ["beneficiary_added", "A payee, a beneficiary or a withdrawal address was added."],
  ["contact_changed", "A phone number or an email address on the account was changed."],
  ["fraud_claim", "A customer says a transaction was not theirs."],
  ["login", "A user signed in."],
  ["login_failed", "A sign-in attempt that did not succeed."],
  ["password_reset", "A password was reset."],
  ["support_message", "Something the customer wrote."],
  ["transaction", "Money moved, or is about to."],
];

/**
 * The published pages, in the order of the sidebar. A slug is the path of the file in docs/
 * without `.md`, or the path of a folder that has a README.md. A file that is not here is not published.
 */
export const groups: DocGroup[] = [
  {
    heading: "Get started",
    items: [
      {
        slug: "getting-started/overview",
        title: "Overview",
        blurb: "What Kairos does, how a decision is made, and what it does not do.",
      },
      {
        slug: "getting-started/quickstart",
        title: "Quickstart",
        blurb: "Make an account and a key, define an action, and get a first decision.",
      },
      {
        slug: "getting-started/import-history",
        title: "Import your history",
        blurb: "Load your transactions, customers and chargebacks, so the first decisions have something to read.",
      },
    ],
  },
  {
    heading: "Platform",
    items: [
      {
        slug: "platform/authentication",
        title: "Authentication",
        blurb: "Secret and public API keys, signed-in sessions, key limits, rotation, and the errors.",
      },
      {
        slug: "platform/environments",
        title: "Environments",
        blurb: "Production and sandboxes: what is separate, how to copy data, and how to move a change to production.",
      },
      {
        slug: "platform/workspaces",
        title: "Workspaces",
        blurb: "Accounts, sign-in, workspaces, roles and invites.",
      },
      {
        section: "Webhooks",
        pages: [
          {
            slug: "platform/webhooks/inbound",
            title: "Inbound",
            blurb: "Let a provider such as Stripe send its webhooks to Kairos, with no code.",
          },
          {
            slug: "platform/webhooks/outbound",
            title: "Outbound",
            blurb: "Signed messages to your system when a decision, a label or a case changes.",
          },
        ],
      },
      {
        slug: "platform/dashboards",
        title: "Dashboards",
        blurb: "Pages of tiles that you build, and what a tile can ask.",
      },
      {
        slug: "platform/workflows",
        title: "Workflows",
        blurb: "Work that Kairos does after an event, a change, a schedule or a call.",
      },
      {
        slug: "platform/models",
        title: "Models",
        blurb: "Question models such as Grayson, and scoring models such as XGBoost that you train on your outcomes.",
      },
      {
        slug: "platform/console",
        title: "The console",
        blurb: "The web interface: the sidebar, the pages, and the settings.",
      },
    ],
  },
  {
    heading: "Concepts",
    items: [
      {
        slug: "concepts/core-concepts",
        title: "Core concepts",
        blurb: "Entities, events, records, sessions, labels, links, actions, policies, models and decisions.",
      },
      {
        slug: "concepts/events",
        title: "Events",
        blurb: "What happened: the shape of an event, how to send it, records that change, and sessions.",
      },
      {
        slug: "concepts/entities",
        title: "Entities",
        blurb: "Users, devices, payees and the rest: how to name them, set their properties and define their types.",
        children: [
          {
            slug: "concepts/entities/facts",
            title: "Facts",
            blurb: "Numbers from an entity's history, on its page and its cases.",
          },
          {
            slug: "concepts/entities/lists",
            title: "Lists",
            blurb: "Tables of an entity's records, a tab each, on its page and its cases.",
          },
        ],
        expanded: true,
      },
      {
        slug: "concepts/actions",
        title: "Actions",
        blurb: "A decision you want made, in plain language: the question, signals, typologies, policy and totals.",
      },
      {
        slug: "concepts/decisions",
        title: "Decisions",
        blurb: "Ask at the moment of action, read the answer, see why, resolve it, and test on the past.",
      },
      {
        slug: "concepts/links",
        title: "Links",
        blurb: "What a decision is told about the other subjects that share a device, an account or a payee.",
      },
    ],
  },
  {
    heading: "Case management",
    items: [
      {
        slug: "case-management/queues",
        title: "Queues",
        blurb: "Which decisions open a case, how cases are grouped, and when a case is due.",
      },
      {
        slug: "case-management/cases",
        title: "Cases",
        blurb: "What a case holds, and how to assign, resolve and reopen it.",
      },
      {
        slug: "case-management/layouts",
        title: "Layouts",
        blurb: "A layout for the cases of each queue, made in the editor.",
      },
    ],
  },
  {
    heading: "Templates",
    items: [
      {
        slug: "templates/overview",
        title: "Overview",
        blurb: "Action definitions, event shapes and webhooks to copy and change.",
      },
      {
        slug: "templates/events",
        title: "Event templates",
        blurb: "Recommended shapes for common events, one page each.",
        children: EVENTS.map(([name, blurb]) => ({ slug: `templates/events/${name}`, title: titleOf(name), blurb })),
      },
    ],
  },
  {
    heading: "Reference",
    items: [
      {
        slug: "reference/api",
        title: "API reference",
        blurb: "Every HTTP endpoint, its request and its response.",
      },
      {
        slug: "reference/mcp",
        title: "MCP",
        blurb: "Connect Cursor, Claude Code and other agents to Kairos through the Model Context Protocol.",
      },
      {
        section: "Clients",
        pages: [
          {
            slug: "reference/clients/typescript",
            title: "TypeScript SDK",
            blurb: "@finic-ai/kairos: record what happens, say what you want decided, and ask at the moment of action.",
          },
          {
            slug: "reference/clients/python",
            title: "Python SDK",
            blurb: "finic-kairos: the same client, with Python names.",
          },
          {
            slug: "reference/clients/cli",
            title: "CLI",
            blurb: "kairos: events, imports, decisions, cases and models from a terminal.",
          },
        ],
      },
    ],
  },
  {
    heading: "Deployment",
    items: [
      {
        slug: "deployment/self-hosting",
        title: "Self-hosting",
        blurb: "Run Kairos on your own infrastructure: Docker, Postgres, migrations, upgrades, backups and security.",
      },
      {
        slug: "deployment/configuration",
        title: "Configuration",
        blurb: "Every environment variable of a self-hosted server.",
      },
      {
        slug: "deployment/sign-in",
        title: "Sign-in and access",
        blurb: "Who can sign up on your server, Supabase and OAuth, and how credentials are kept.",
      },
    ],
  },
];

const withChildren = (p: DocPage): DocPage[] => [p, ...(p.children ?? [])];

/** The pages of a group, with the pages of its sections, in the order of the sidebar. */
export const groupPages = (g: DocGroup): DocPage[] => g.items.flatMap((i) => (isSection(i) ? i.pages : [i]));

export const pages: DocPage[] = groups.flatMap((g) => groupPages(g).flatMap(withChildren));

/**
 * What a page's title needs beside it to be clear: its section, such as "Webhooks" for Inbound,
 * or its group when another page has the same title, such as "Templates" for Overview.
 */
export const contextOf = (page: DocPage): string | undefined => {
  const section = groups
    .flatMap((g) => g.items)
    .find((i): i is DocSection => isSection(i) && i.pages.includes(page))?.section;
  if (section) return section;
  if (pages.filter((p) => p.title === page.title).length < 2) return undefined;
  return groups.find((g) => groupPages(g).flatMap(withChildren).includes(page))?.heading;
};
export const slugs = new Set(pages.map((p) => p.slug));
