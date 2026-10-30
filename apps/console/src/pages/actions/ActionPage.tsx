import { api } from "../../api/index";
import { CodeList } from "../../components/actions/CodeList";
import { Card } from "../../components/ui/Card";
import { Failure, Loading } from "../../components/ui/states";
import { useApi } from "../../hooks/useApi";
import { conditionText, snippet, totalSentence } from "../../lib/actions";
import { actionName, entityName, stamp, triggerText } from "../../lib/format";
import { OUTCOME_LABEL } from "../../lib/outcomes";
import { href } from "../../lib/route";

export function ActionPage({ name }: { name: string }) {
  const { data: a, error } = useApi(["action", name], () => api.action(name));
  const { data: numbers } = useApi(["action-numbers", name], () => {
    const to = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000);
    const period = { from: new Date(to.getTime() - 30 * 86_400_000).toISOString(), to: to.toISOString() };
    const about = { source: "decisions" as const, filters: { action: name } };
    return Promise.all([
      api.metric({ ...about, measure: "count", ...period }),
      api.metric({ ...about, measure: "share", field: "review,block", ...period }),
    ]).catch(() => null);
  });
  const { data: auto } = useApi(["automatic-estimate", name], () => api.automaticEstimate(name).catch(() => null), {
    enabled: !!a?.automatic,
  });
  if (error) return <Failure message={error.message} />;
  if (!a) return <Loading />;

  const review = a.policy?.review ?? 0.5;
  const block = a.policy?.block ?? 0.9;
  const rules = a.policy?.rules ?? [];
  const decided = numbers?.[0].total ?? 0;
  return (
    <>
      <a className="crumb" href={href("actions")}>
        ← Actions
      </a>
      <header className="page-head">
        <div>
          <h1>{actionName(a)}</h1>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <span className="chip">{a.name}</span>
            <span className="chip accent">Version {a.version}</span>
          </div>
          {a.description && <p className="lede">{a.description}</p>}
        </div>
        <div className="row">
          <a className="btn" href={`${href("decisions")}?action=${encodeURIComponent(a.name)}`}>
            View decisions
          </a>
          <a className="btn" href={`${href("queues", "new")}?action=${encodeURIComponent(a.name)}`}>
            Make a queue
          </a>
          <a className="btn primary" href={href("actions", a.name, "edit")}>
            Edit
          </a>
        </div>
      </header>

      <div className="summary-row">
        <div className="card">
          <span>Decides about</span>
          <b>
            <a href={href("entities", a.subject)}>{entityName(a.subject)}</a>
          </b>
          <small>The entity whose history is read.</small>
        </div>
        <div className="card">
          <span>Runs</span>
          <b>{a.automatic ? "Automatically" : a.trigger ? "On an event" : "On request"}</b>
          <small>
            {a.automatic ? (
              <>
                On each <span className="mono">{triggerText(a.trigger)}</span> event that your server or a webhook
                sends, in the background{a.automaticSince ? `, since ${stamp(a.automaticSince)} UTC` : ""}.
                {auto && auto.missed_last_day > 0 && (
                  <span className="wh-failed">
                    {" "}
                    {auto.missed_last_day} in the last day were not decided within the hour.
                  </span>
                )}
              </>
            ) : a.trigger ? (
              <>
                When a <span className="mono">{triggerText(a.trigger)}</span> event is sent for a decision.
              </>
            ) : (
              "When your server asks Kairos for this decision."
            )}
          </small>
        </div>
        <div className="card">
          <span>Decisions, last 30 days</span>
          <b>{numbers ? decided.toLocaleString() : "—"}</b>
          <small>{decided === 0 ? "None yet." : "All versions of this action."}</small>
        </div>
        <div className="card">
          <span>Held for review or blocked</span>
          <b>
            {numbers && decided > 0
              ? `${numbers[1].total.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
              : "—"}
          </b>
          <small>Of those decisions.</small>
        </div>
      </div>

      <div className="split">
        <div className="stack">
          <Card title="The question">
            <p className="question">{a.hold}</p>
            <p className="note" style={{ margin: "12px 0 0" }}>
              The model answers yes or no. The probability of yes is the risk score.
            </p>
          </Card>
          <Card title={`Signals · ${Object.keys(a.reasons ?? {}).length}`}>
            <CodeList items={a.reasons} empty="No signals. The decision returns a score and no reasons." />
          </Card>
          <Card title={`Typologies · ${Object.keys(a.typologies ?? {}).length}`}>
            <CodeList
              items={a.typologies}
              empty="No typologies. The decision does not name the most likely explanation."
            />
          </Card>
          <Card title={`Totals · ${a.context?.totals?.length ?? 0}`}>
            <CodeList
              items={Object.fromEntries((a.context?.totals ?? []).map((t) => [t.name, totalSentence(t)]))}
              empty="No totals. The model sees the last 30 events in full and a summary of the older ones, with no sums."
            />
          </Card>
        </div>
        <aside className="stack">
          <Card title="Policy">
            <div className="threshold">
              <span className="tick" style={{ left: `${review * 100}%` }}>
                {review.toFixed(2)}
              </span>
              <span className="tick" style={{ left: `${Math.min(block * 100, 93)}%` }}>
                {block.toFixed(2)}
              </span>
              <div className="zone t-approve" style={{ width: `${review * 100}%` }}>
                {review >= 0.18 && "Approve"}
              </div>
              <div className="zone t-review" style={{ width: `${Math.max(block - review, 0) * 100}%` }}>
                {block - review >= 0.18 && "Review"}
              </div>
              <div className="zone t-block" style={{ flex: 1 }}>
                {1 - block >= 0.18 && "Block"}
              </div>
            </div>
            <p className="note" style={{ margin: 0 }}>
              A score of {Math.round(review * 100)} or more goes to review. A score of {Math.round(block * 100)} or more
              is blocked.
            </p>
          </Card>
          <Card title={`Rules · ${rules.length}`}>
            {rules.length === 0 ? (
              <p className="note" style={{ margin: 0 }}>
                No rules. Only the score decides the outcome.
              </p>
            ) : (
              <div className="rule-list">
                {rules.map((rule) => (
                  <div key={rule.id}>
                    <div className="chips">
                      {rule.allOf.map((code) => (
                        <span key={code} className="chip">
                          {code}
                        </span>
                      ))}
                      {(rule.when ?? []).map((condition, i) => (
                        <span key={i} className="chip accent">
                          {conditionText(condition)}
                        </span>
                      ))}
                    </div>
                    <span className="then">
                      → at least <b>{OUTCOME_LABEL[rule.outcome]}</b>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card title="How to run it">
            <pre>{snippet(a)}</pre>
            <p className="note" style={{ margin: "10px 0 0" }}>
              {a.trigger
                ? "The event is stored, and the decision comes back in the same call."
                : "Call this from your server, at the moment the user asks for the action."}
            </p>
          </Card>
        </aside>
      </div>
    </>
  );
}
