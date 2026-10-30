import { EntityIcon } from "../../components/entities/EntityIcon";
import { Empty, Failure, Loading } from "../../components/ui/states";
import { useQueues } from "../../hooks/useApi";
import { QUEUE_DISPLAY, correlationSentence } from "../../lib/queues";
import { go, href } from "../../lib/route";

export function QueuesPage() {
  const { data, error } = useQueues(15_000);
  return (
    <>
      <header className="page-head with-actions">
        <div>
          <h1>Queues</h1>
          <p className="lede">
            Lists of work for people. Each queue has rules that say which decisions need a person, and each case in it
            is one request to review, with its decisions, events and entities.
          </p>
        </div>
        <div className="row">
          <a className="btn primary" href={href("queues", "new")}>
            New queue
          </a>
        </div>
      </header>
      {error && <Failure message={error.message} />}
      {!data ? (
        <Loading />
      ) : data.queues.length === 0 ? (
        <div className="card">
          <Empty title="No queues yet">
            Make a queue for one kind of work, such as onboarding review. Its rules then open a case for each request
            that needs a person.
          </Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <div className="table-head">
            {data.queues.length} {data.queues.length === 1 ? "queue" : "queues"}
          </div>
          <table>
            <thead>
              <tr>
                <th>Queue</th>
                <th className="hide-md">Description</th>
                <th style={{ textAlign: "right" }}>Open</th>
                <th style={{ textAlign: "right" }}>In review</th>
                <th style={{ textAlign: "right" }}>Unassigned</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.queues.map((q) => {
                const display = QUEUE_DISPLAY(q);
                return (
                  <tr key={q.id} className="link big" onClick={() => go("queues", q.id)}>
                    <td className="wrap">
                      <div className="row" style={{ gap: 10 }}>
                        <EntityIcon icon={display.icon} color={display.color} size="sm" />
                        <a className="linkish" href={href("queues", q.id)} onClick={(e) => e.stopPropagation()}>
                          <b>{q.name}</b>
                        </a>
                        {q.visibility === "private" && <span className="chip">Only you</span>}
                      </div>
                    </td>
                    <td className="hide-md muted wrap">
                      {q.description ?? correlationSentence(q.correlation).split(".")[0]}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {(q.counts?.open ?? 0).toLocaleString()}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {(q.counts?.in_review ?? 0).toLocaleString()}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {(q.counts?.unassigned ?? 0).toLocaleString()}
                    </td>
                    <td>
                      {q.enabled === false ? (
                        <span className="chip">Disabled</span>
                      ) : (
                        <span className="chip ok">Enabled</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
