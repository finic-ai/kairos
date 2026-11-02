import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { workspaces } from "../../api/index";
import { FilterSelect } from "../../components/ui/FilterSelect";
import { Empty, Loading } from "../../components/ui/states";
import { useMembers } from "../../hooks/useApi";
import { durationText, stamp } from "../../lib/format";
import type { Activity, Member } from "../../types/interfaces";
import type { SettingsPageProps } from "./types";

const PAGE = 50;

const RESOURCES: [string, string][] = [
  ["action", "Action"],
  ["api_key", "API key"],
  ["case", "Case"],
  ["dashboard", "Dashboard"],
  ["decision", "Decision"],
  ["entity", "Entity"],
  ["entity_type", "Entity type"],
  ["environment", "Environment"],
  ["event", "Event"],
  ["invite", "Invite"],
  ["job", "Job"],
  ["label", "Label"],
  ["member", "Member"],
  ["model", "Model"],
  ["queue", "Queue"],
  ["webhook", "Webhook"],
  ["workflow", "Workflow"],
  ["workflow_run", "Workflow run"],
  ["workspace", "Workspace"],
];
const NOUN = Object.fromEntries(
  RESOURCES.map(([id, label]) => [id, id === "api_key" ? label : label.toLowerCase()]),
) as Record<string, string>;

/** What a verb of an action says, when the verb alone does not read well. */
const VERBS: Record<string, string> = {
  draft_saved: "saved a draft of",
  draft_discarded: "discarded the draft of",
  hook_rotated: "made a new trigger URL for",
  training_data_exported: "exported training data from",
  token_rotated: "made a new URL for",
  secret_rotated: "rotated the secret of",
  resent: "resent deliveries of",
  role_changed: "changed the role of",
  note_added: "added a note to",
  checked: "updated the checklist of",
  bulk_updated: "updated cases in",
  version_uploaded: "uploaded a version of",
  version_promoted: "promoted a version of",
  media_hosts_updated: "changed the media hosts of",
};

const ADDS = new Set(["created", "added", "joined", "invited", "version_uploaded", "started", "sent"]);
const REMOVES = new Set(["deleted", "revoked", "removed", "left", "draft_discarded", "cancelled"]);

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

interface Sentence {
  verb: string;
  noun?: string;
  name?: string;
  rest?: string;
}

/** "deleted" + "API key" + "server": the parts of the sentence after who did it. */
function describe(a: Activity, members: Map<string, Member>): Sentence {
  const [, verb = a.action] = a.action.split(/\.(.*)/);
  const d = a.details;
  const noun = NOUN[a.resource_type] ?? a.resource_type.replaceAll("_", " ");
  switch (a.action) {
    case "member.joined":
      return { verb: "joined the workspace" };
    case "member.left":
      return { verb: "left the workspace" };
    case "mcp.settings_updated":
      return { verb: "changed the MCP settings" };
    case "workspace.created":
      return { verb: "created the workspace", name: text(d.name) };
    case "workspace.renamed":
      return { verb: "renamed the workspace to", name: text(d.name) };
    case "workspace.media_hosts_updated":
      return { verb: "changed the media hosts of the workspace" };
    case "environment.client_settings_updated":
      return { verb: "changed the client settings" };
    case "environment.renamed":
      return { verb: "renamed", noun, name: text(d.from), rest: `to ${text(d.to) ?? ""}` };
    case "model.renamed":
      return { verb: "renamed", noun, name: a.resource_id ?? undefined, rest: `to ${text(d.name) ?? ""}` };
    case "workflow_run.started":
      return { verb: "started a run of", noun: "workflow", name: text(d.workflow) };
    case "workflow_run.tested":
      return { verb: "tested", noun: "workflow", name: text(d.workflow) };
    case "workflow_run.cancelled":
      return { verb: "cancelled a run of", noun: "workflow", name: text(d.workflow)?.split("@")[0] };
    case "decision.requested":
      return { verb: "asked for a decision of", noun: "action", name: a.resource_id ?? undefined };
    case "event.sent":
      return { verb: typeof d.count === "number" && d.count > 1 ? `sent ${d.count} events` : "sent an event" };
    case "label.added":
      return { verb: typeof d.count === "number" && d.count > 1 ? `added ${d.count} labels` : "added a label" };
    case "entity.batch_updated":
      return { verb: `updated ${typeof d.count === "number" ? d.count : ""} entities` };
    case "command.issued":
      return { verb: "issued", name: text(d.label) ?? text(d.command), noun: "on", rest: a.resource_id ?? undefined };
  }
  const member = a.resource_type === "member" && a.resource_id ? members.get(a.resource_id) : undefined;
  const name =
    member?.name ?? text(d.name) ?? text(d.email) ?? (a.resource_type === "member" ? undefined : a.resource_id);
  return {
    verb: VERBS[verb] ?? verb.replaceAll("_", " "),
    noun: a.resource_type === "member" && !member ? "a member" : noun,
    ...(name ? { name } : {}),
    ...(a.action === "member.role_changed" && text(d.role) ? { rest: `to ${d.role}` } : {}),
  };
}

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

const day = (date: Date) => date.toISOString().slice(0, 10);
const monthOf = (ts: string) => new Date(ts).toLocaleDateString("en-US", { month: "long", year: "numeric" });

function Icon({ verb }: { verb: string }) {
  if (REMOVES.has(verb))
    return (
      <svg className="activity-icon remove" viewBox="0 0 16 16" aria-hidden>
        <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" />
      </svg>
    );
  if (ADDS.has(verb))
    return (
      <svg className="activity-icon add" viewBox="0 0 16 16" aria-hidden>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5.5v5M5.5 8h5" />
      </svg>
    );
  return (
    <svg className="activity-icon change" viewBox="0 0 16 16" aria-hidden>
      <path d="M10.5 3.5l2 2L6 12H4v-2l6.5-6.5Z" />
    </svg>
  );
}

export function ActivityPage({ workspace, session }: SettingsPageProps) {
  const admin = workspace.role !== "member";
  const me = session.user.id;
  const today = new Date();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [resource, setResource] = useState("");
  const [user, setUser] = useState("");
  const [from, setFrom] = useState(day(new Date(today.getTime() - 30 * 86_400_000)));
  const [to, setTo] = useState(day(today));
  useEffect(() => {
    const wait = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(wait);
  }, [search]);

  const { data: team } = useMembers(workspace.id);
  const members = useMemo(() => new Map((team?.members ?? []).map((m) => [m.id, m])), [team]);
  const filter = { q, resource, user: admin ? user : "", from, to };
  const list = useInfiniteQuery({
    queryKey: ["activities", workspace.id, filter],
    queryFn: ({ pageParam }) =>
      workspaces.activities(workspace.id, { ...filter, limit: PAGE, ...(pageParam ? { after: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (page) => page.next ?? undefined,
  });
  const activities = list.data?.pages.flatMap((p) => p.activities) ?? [];
  const months = activities.reduce<[string, Activity[]][]>((groups, a) => {
    const month = monthOf(a.created);
    const last = groups[groups.length - 1];
    if (last?.[0] === month) last[1].push(a);
    else groups.push([month, [a]]);
    return groups;
  }, []);
  const filtered = Boolean(q || resource || (admin && user));
  const environments = new Map(workspace.environments.map((e) => [e.id, e.name]));

  return (
    <>
      <h1>Activity</h1>
      <p className="lede muted">
        {admin ? "View team activity across this workspace." : "View your activity in this workspace."}
      </p>

      <div className="filter-bar activity-filters">
        <label className="input search activity-search">
          <svg viewBox="0 0 16 16" aria-hidden>
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" />
          </svg>
          <input
            placeholder="Search activity…"
            aria-label="Search activity"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <FilterSelect label="Any resource" value={resource} onChange={setResource} options={RESOURCES} />
        {admin && (
          <FilterSelect
            label="Performed by anyone"
            value={user}
            onChange={setUser}
            options={[...members.values()]
              .sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.name.localeCompare(b.name)))
              .map((m) => [m.id, m.id === me ? "You" : m.name])}
          />
        )}
        <div className="input activity-dates">
          <svg viewBox="0 0 16 16" aria-hidden>
            <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
            <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
          </svg>
          <input type="date" aria-label="From" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          <span className="muted">–</span>
          <input type="date" aria-label="To" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {list.error && <div className="banner">{list.error.message}</div>}
      {!list.data ? (
        <Loading />
      ) : activities.length === 0 ? (
        <div className="card">
          <Empty title={filtered ? "No activity matches" : "No activity in these days"}>
            {filtered ? "Change the filters, or the days." : "Changes to the workspace show here."}
          </Empty>
        </div>
      ) : (
        <>
          {months.map(([month, items]) => (
            <section className="activity-month" key={month}>
              <h2>{month}</h2>
              <ol className="activity-list">
                {items.map((a) => {
                  const s = describe(a, members);
                  const who = !a.user ? "A deleted user" : a.user.id === me ? "You" : a.user.name;
                  const env =
                    a.environment_id && workspace.environments.length > 1 && environments.get(a.environment_id);
                  return (
                    <li key={a.id}>
                      <Icon verb={a.action.split(".").slice(1).join(".")} />
                      <span className="activity-who" title={a.user?.email}>
                        {initials(a.user?.name ?? "?") || "?"}
                      </span>
                      <span className="activity-text">
                        <b>{who}</b> <span className="muted">{s.verb}</span>
                        {s.noun && <span className="muted"> {s.noun}</span>}
                        {s.name && <b> {s.name}</b>}
                        {s.rest && <span className="muted"> {s.rest}</span>}
                        {env && <span className="chip activity-env">{env}</span>}
                      </span>
                      <time className="muted" dateTime={a.created} title={`${stamp(a.created)} UTC`}>
                        {durationText(Date.now() - Date.parse(a.created))} ago
                      </time>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          {list.hasNextPage && (
            <button className="btn ghost" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
              {list.isFetchingNextPage ? "Loading…" : "Show more"}
            </button>
          )}
        </>
      )}
    </>
  );
}
