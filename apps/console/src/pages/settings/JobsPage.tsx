import { useState } from "react";
import { jobs } from "../../api/index";
import { FilterSelect } from "../../components/ui/FilterSelect";
import { Group } from "../../components/ui/Group";
import { Modal } from "../../components/ui/Modal";
import { Empty, Loading } from "../../components/ui/states";
import { useApi } from "../../hooks/useApi";
import { stamp } from "../../lib/format";
import { href } from "../../lib/route";
import type { Job, JobStatus, Workspace } from "../../types/interfaces";
import type { SettingsPageProps } from "./types";

const KIND_LABELS: Record<string, string> = {
  "webhook.deliver": "Webhook delivery",
  "workflow.run": "Workflow run",
  "decision.automatic": "Automatic decision",
};
const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

const FILTERS: [JobStatus | "", string][] = [
  ["", "All"],
  ["dead", "Failed"],
  ["pending", "Waiting"],
  ["paused", "Paused"],
  ["done", "Done"],
];
const TONE: Record<JobStatus, string> = { done: "ok", pending: "review", dead: "warn", paused: "" };
const PAGE = 50;

function JobStatusChip({ job }: { job: Job }) {
  const label =
    job.status === "pending"
      ? job.last_error
        ? "Retrying"
        : "Waiting"
      : job.status === "dead"
        ? "Failed"
        : job.status === "paused"
          ? "Paused"
          : "Done";
  return <span className={`chip ${TONE[job.status]}`}>{label}</span>;
}

/** The next run of a job that waits, or the end of one that is over. */
const when = (job: Job) =>
  job.status === "pending" || job.status === "paused" ? stamp(job.run_at) : job.finished ? stamp(job.finished) : "";

export function JobsPage({ workspace, environment }: SettingsPageProps) {
  const admin = workspace.role !== "member";
  const [status, setStatus] = useState<JobStatus | "">("");
  const [kind, setKind] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [opened, setOpened] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { data: summary, refetch: reloadSummary } = useApi(
    ["job-summary", workspace.id, environment.id],
    () => jobs.summary(workspace.id),
    { enabled: admin, refetchInterval: 5_000 },
  );
  const {
    data: list,
    error: loadError,
    refetch: reloadList,
  } = useApi(
    ["jobs", workspace.id, environment.id, status, kind, limit],
    () => jobs.list(workspace.id, { status: status || undefined, kind: kind || undefined, limit }),
    { enabled: admin, refetchInterval: 5_000 },
  );
  const count = (s: JobStatus | "") =>
    summary ? (s ? summary.statuses[s] : Object.values(summary.statuses).reduce((a, b) => a + b, 0)) : null;

  return (
    <>
      <h1>Jobs</h1>
      {loadError && <div className="banner">{loadError.message}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <Group
        title={`Background work in ${environment.name}`}
        note="Webhook deliveries, workflow runs and automatic decisions. A failed job is retried on its own until it runs out of attempts; then it is Failed, and you can run it again. Done jobs are kept for 7 days, failed ones for 30."
      >
        {admin && (
          <div className="row wrap jobs-filters">
            <div className="seg">
              {FILTERS.map(([value, label]) => (
                <button
                  key={value}
                  className={status === value ? "on" : ""}
                  onClick={() => (setStatus(value), setLimit(PAGE))}
                >
                  {label}
                  {count(value) !== null && <span className="count">{count(value)}</span>}
                </button>
              ))}
            </div>
            <FilterSelect
              label="All kinds"
              value={kind}
              onChange={(v) => (setKind(v), setLimit(PAGE))}
              options={(summary?.kinds ?? []).map((k) => [k.kind, kindLabel(k.kind)])}
            />
          </div>
        )}
        <div className="card table-wrap">
          {!admin ? (
            <Empty title="You don't have access to jobs">Ask a workspace owner or admin.</Empty>
          ) : !list ? (
            <Loading />
          ) : list.jobs.length === 0 ? (
            <Empty title={status || kind ? "No jobs match" : "No jobs yet"}>
              {status || kind
                ? null
                : "Jobs show here when a webhook sends, a workflow runs or a decision is automatic."}
            </Empty>
          ) : (
            <table className="jobs-log">
              <thead>
                <tr>
                  <th>Made</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th className="hide-md">Next or ended</th>
                  <th className="hide-md">Last error</th>
                </tr>
              </thead>
              <tbody>
                {list.jobs.map((job) => (
                  <tr key={job.id} className="link" onClick={() => setOpened(job.id)}>
                    <td className="mono">{stamp(job.created)}</td>
                    <td>
                      {kindLabel(job.kind)}
                      <div className="muted mono jobs-key">{job.key}</div>
                    </td>
                    <td>
                      <JobStatusChip job={job} />
                    </td>
                    <td className="hide-md mono muted jobs-when">{when(job)}</td>
                    <td className="hide-md muted jobs-error">{job.last_error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {list?.next_offset && (
          <button className="btn ghost usage-more" onClick={() => setLimit(limit + PAGE)}>
            Show more
          </button>
        )}
      </Group>

      {opened && (
        <JobModal
          workspace={workspace}
          id={opened}
          onClose={() => setOpened(null)}
          onRetried={() => (
            setOpened(null),
            setNotice("The job is queued to run again."),
            reloadList(),
            reloadSummary()
          )}
        />
      )}
    </>
  );
}

function JobModal({
  workspace,
  id,
  onClose,
  onRetried,
}: {
  workspace: Workspace;
  id: string;
  onClose: () => void;
  onRetried: () => void;
}) {
  const { data: job, error } = useApi(["job", workspace.id, id], () => jobs.get(workspace.id, id));
  const [failed, setFailed] = useState<string | null>(null);
  const runId = job?.kind === "workflow.run" && typeof job.payload?.run_id === "string" ? job.payload.run_id : null;
  return (
    <Modal title="Job" onClose={onClose} wide>
      <div className="modal-body">
        {(error ?? failed) && (
          <div className="banner" style={{ margin: 0 }}>
            {error?.message ?? failed}
          </div>
        )}
        {!job ? (
          <Loading />
        ) : (
          <>
            <div className="wh-facts">
              <div>
                <span>Status</span>
                <JobStatusChip job={job} />
              </div>
              <div>
                <span>Kind</span>
                <b>{kindLabel(job.kind)}</b>
              </div>
              <div>
                <span>Key</span>
                <b className="mono">{job.key}</b>
              </div>
              <div>
                <span>Attempts</span>
                <b className="mono">{job.attempts}</b>
              </div>
              <div>
                <span>Made</span>
                <b className="mono">{stamp(job.created)} UTC</b>
              </div>
              {when(job) && (
                <div>
                  <span>{job.finished ? "Ended" : "Next run"}</span>
                  <b className="mono">{stamp(job.finished ?? job.run_at)} UTC</b>
                </div>
              )}
            </div>
            {runId && (
              <p>
                Part of workflow run{" "}
                <a className="mono" href={href("workflow-runs", runId)}>
                  {runId}
                </a>
              </p>
            )}
            {job.last_error && (
              <div className="wh-pre">
                <h3>Last error</h3>
                <pre>{job.last_error}</pre>
              </div>
            )}
            <div className="wh-pre">
              <h3>Payload</h3>
              <pre>{JSON.stringify(job.payload ?? {}, null, 2)}</pre>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={onClose}>
                Close
              </button>
              {job.status === "dead" && (
                <button
                  className="btn primary"
                  onClick={() => jobs.retry(workspace.id, job.id).then(onRetried, (e: Error) => setFailed(e.message))}
                >
                  Run again
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
