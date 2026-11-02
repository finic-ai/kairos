import { useState } from "react";
import { queues } from "../../api/index";
import { TypeIcon } from "../../components/entities/EntityIcon";
import { InTopbar } from "../../components/shell/InTopbar";
import { Failure, Loading } from "../../components/ui/states";
import { useActionNames } from "../../hooks/useActionNames";
import { useApi, useMembers } from "../../hooks/useApi";
import { useEntityDefinitions } from "../../hooks/useEntityDefinitions";
import { useWorkspace } from "../../hooks/useWorkspace";
import { entityName, stamp } from "../../lib/format";
import { CATEGORY_LABEL, STATUS_LABEL } from "../../lib/queues";
import { href } from "../../lib/route";
import type { CaseDetail, CaseViewData } from "../../types/interfaces";
import { CommandCard, type CommandGroup } from "../../components/entities/Commands";
import { AssignMenu } from "./AssignMenu";
import { CaseBlock, TargetName, ValueText, type CaseContext } from "./CaseBlocks";
import { ResolveModal } from "./ResolveModal";

function CaseLayout({
  c,
  view,
  ctx,
  commands,
}: {
  c: CaseDetail;
  view: CaseViewData;
  ctx: CaseContext;
  commands: CommandGroup[];
}) {
  const main = view.blocks.filter((b) => b.region === "main");
  const side = view.blocks.filter((b) => b.region === "side");
  const timelineAt = main.findIndex((b) => b.type === "timeline");
  const before = timelineAt === -1 ? main : main.slice(0, timelineAt);
  const after = timelineAt === -1 ? [] : main.slice(timelineAt);
  const block = (b: (typeof main)[number]) => (
    <div key={b.id} className="view-block" style={{ gridColumn: `span ${b.w ?? 12}` }}>
      <CaseBlock block={b} ctx={ctx} />
    </div>
  );
  return (
    <div className="split detail" key={c.id}>
      <div className="view-main">
        {before.map(block)}
        <div className="view-block" style={{ gridColumn: "span 12" }}>
          <CommandCard page="case" groups={commands} />
        </div>
        {after.map(block)}
      </div>
      <aside className="stack">
        {side.map((b) => (
          <CaseBlock key={b.id} block={b} ctx={ctx} />
        ))}
      </aside>
    </div>
  );
}

export function CasePage({ id }: { id: string }) {
  const { workspace, session } = useWorkspace();
  const names = useActionNames();
  const definitions = useEntityDefinitions();
  const { data: c, error, refetch } = useApi(["case", id], () => queues.case(id), { refetchInterval: 10_000 });
  const view = useApi(["case-view", id], () => queues.view(id), { refetchInterval: 30_000 });
  const { data: memberList } = useMembers(workspace.id);
  const [resolving, setResolving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <Failure message={error.message} />;
  if (!c) return <Loading />;

  // An activity names a person by email, an assignment by user id.
  const members = Object.fromEntries(
    (memberList?.members ?? []).flatMap((m) => [
      [m.id, m.name || m.email],
      [m.email, m.name || m.email],
    ]),
  );
  const reload = () => (refetch(), view.refetch());
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      reload();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const me = session.user.id;
  const resolved = c.status === "resolved";
  const statusTone = resolved ? "ok" : c.status === "in_review" ? "accent" : "";
  const ctx: CaseContext = {
    c,
    me,
    members,
    actions: names,
    definitions,
    busy,
    act,
    caseRows: new Set(c.items.map((i) => i.id)),
  };

  return (
    <>
      <InTopbar slot="trail-slot">
        <a href={href("queues", c.queue.id)}>{c.queue.name}</a>
        <span>›</span>
        <span className={`here ${c.target_name ? "" : "mono"}`}>{c.target_name ?? c.target.id}</span>
      </InTopbar>
      <header className="page-head with-actions">
        <div className="profile-head">
          <TypeIcon type={c.target.type} definition={definitions[c.target.type]} size="lg" />
          <div>
            {c.target_name ? (
              <div className="title-line">
                <h1>{c.target_name}</h1>
                <span className="mono muted">{c.target.id}</span>
              </div>
            ) : (
              <h1 className="mono-title">{c.target.id}</h1>
            )}
            <div className="queue-facts">
              <span className={`chip ${statusTone}`}>{STATUS_LABEL[c.status]}</span>
              <span>
                {entityName(c.target.type)} · {c.reason}
              </span>
            </div>
            {view.data && view.data.header.length > 0 && (
              <dl className="case-header-fields">
                {view.data.header.map((v) => (
                  <div key={v.field}>
                    <dt>{v.label}</dt>
                    <dd>
                      <ValueText v={v} />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>
        <div className="row">
          {resolved ? (
            <button className="btn" disabled={busy} onClick={() => act(() => queues.reopen(c.id))}>
              Reopen
            </button>
          ) : (
            <>
              <AssignMenu
                me={me}
                assignee={c.assignee}
                members={memberList?.members ?? []}
                disabled={busy}
                onAssign={(userId) => act(() => (userId === me ? queues.take(c.id) : queues.assign(c.id, userId)))}
              />
              <button className="btn primary" onClick={() => setResolving(true)}>
                Resolve
              </button>
            </>
          )}
        </div>
      </header>
      {c.resolution && (
        <div className="banner ok">
          <b>{CATEGORY_LABEL[c.resolution.category]}</b> by {members[c.resolution.by] ?? c.resolution.by} ·{" "}
          {stamp(c.resolution.at)} UTC{c.resolution.note && ` · ${c.resolution.note}`}
        </div>
      )}
      {problem && <div className="banner">{problem}</div>}
      {resolving && (
        <ResolveModal
          title="Resolve this case"
          decisions={(target) => {
            const changes = c.decisions.filter((d) => !d.resolution && d.decision.decision !== target).length;
            return (
              <>
                the {changes} open {changes === 1 ? "decision" : "decisions"} of this case as{" "}
                {target === "approve" ? "approved" : "blocked"}
              </>
            );
          }}
          label={(tag) => (
            <>
              {entityName(c.target.type)} <TargetName c={c} /> <span className="mono">{tag}</span>
            </>
          )}
          onResolve={async (body) => {
            await queues.resolve(c.id, body);
            setResolving(false);
            reload();
          }}
          onClose={() => setResolving(false)}
        />
      )}

      {view.data && (
        <CaseLayout
          c={c}
          view={view.data}
          ctx={ctx}
          commands={[
            {
              entity: c.target,
              name: c.target_name,
              commands: definitions[c.target.type]?.commands,
              caseId: c.id,
              onDone: reload,
            },
            ...c.items
              .filter((item) => item.kind === "entity" && !(item.type === c.target.type && item.id === c.target.id))
              .map((item) => ({
                entity: { type: item.type!, id: item.id },
                name: c.names[`${item.type} ${item.id}`],
                commands: definitions[item.type!]?.commands,
                caseId: c.id,
                onDone: reload,
              })),
          ]}
        />
      )}
    </>
  );
}
