import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../api/index";
import type { Outcome } from "../../types/interfaces";
import { Pill, Score } from "../../components/decisions/Outcome";
import { PAGE_SIZES, Pager } from "../../components/ui/Pager";
import { Empty, Failure, Loading } from "../../components/ui/states";
import { useActions, useApi } from "../../hooks/useApi";
import { durationText, stamp } from "../../lib/format";
import { OUTCOME_LABEL, OUTCOMES } from "../../lib/outcomes";
import { go, hashQuery } from "../../lib/route";

export function SessionsPage() {
  const [, setSearchParams] = useSearchParams();
  const [q, setQ] = useState(() => hashQuery().get("q") ?? "");
  const [outcome, setOutcome] = useState<Outcome | "any" | "">(() => {
    const asked = hashQuery().get("outcome") ?? "";
    return asked === "any" || OUTCOMES.includes(asked as Outcome) ? (asked as Outcome | "any") : "";
  });
  const [size, setSize] = useState(() =>
    PAGE_SIZES.includes(Number(hashQuery().get("size"))) ? Number(hashQuery().get("size")) : 50,
  );
  const [page, setPage] = useState(() => Math.max(1, Math.floor(Number(hashQuery().get("page"))) || 1));
  const filter = (change: () => void) => (change(), setPage(1));
  const [asked, setAsked] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setAsked(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const list = useApi(
    ["sessions", { asked, outcome, size, page }],
    () => api.sessions({ q: asked, outcome, limit: size, offset: (page - 1) * size }),
    { refetchInterval: 8000 },
  );
  const actions = useActions();
  const subjects = [...new Set(["user", ...(actions.data?.actions ?? []).map((a) => a.subject)])];
  const matching = list.data?.total ?? 0;
  const shown = list.data?.sessions.length ?? 0;
  const pages = Math.max(1, Math.ceil(matching / size));
  const filtered = Boolean(asked || outcome);

  useEffect(() => {
    const query = new URLSearchParams();
    if (asked) query.set("q", asked);
    if (outcome) query.set("outcome", outcome);
    if (page > 1) query.set("page", String(page));
    if (size !== 50) query.set("size", String(size));
    setSearchParams(query, { replace: true });
  }, [asked, outcome, page, size]);
  useEffect(() => {
    if (list.data && page > pages) setPage(pages);
  }, [list.data, page, pages]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Sessions</h1>
          <p className="lede">
            One row for each visit: the events that were sent with the same <span className="mono">$session</span>, and
            what Kairos decided in it.
          </p>
        </div>
        <button className="btn" onClick={() => list.refetch()}>
          Refresh
        </button>
      </header>

      {list.error && <Failure message={list.error.message} />}

      <div className="filters">
        <input
          className="input mono"
          style={{ maxWidth: 260 }}
          placeholder="Part of a session id"
          aria-label="Search by session id"
          value={q}
          onChange={(e) => filter(() => setQ(e.target.value))}
        />
        <div className="seg scroll">
          <button className={outcome === "" ? "on" : ""} onClick={() => filter(() => setOutcome(""))}>
            All sessions
          </button>
          <button
            className={outcome === "any" ? "on" : ""}
            onClick={() => filter(() => setOutcome(outcome === "any" ? "" : "any"))}
          >
            With a decision
          </button>
          {OUTCOMES.map((o) => (
            <button
              key={o}
              className={`t-${o} ${outcome === o ? "on" : ""}`}
              onClick={() => filter(() => setOutcome(outcome === o ? "" : o))}
            >
              <i />
              {OUTCOME_LABEL[o]}
            </button>
          ))}
        </div>
      </div>

      <div className="card table-wrap">
        <div className="table-head">
          {!list.data
            ? "Loading…"
            : `${matching.toLocaleString()} ${matching === 1 ? "session" : "sessions"}${filtered ? " matching" : ""}`}
        </div>
        {!list.data ? (
          <Loading />
        ) : shown === 0 ? (
          <Empty title={filtered ? "No sessions match" : "No sessions yet"}>
            {filtered ? (
              "Change the filters."
            ) : (
              <>
                Send <span className="mono">$session</span> with your events and decisions: the id of the login session
                in your own system.
              </>
            )}
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Who</th>
                <th>Decided</th>
                <th>Risk</th>
                <th style={{ textAlign: "right" }}>Events</th>
                <th className="hide-md" style={{ textAlign: "right" }}>
                  Lasted
                </th>
                <th style={{ textAlign: "right" }}>Last active</th>
              </tr>
            </thead>
            <tbody>
              {list.data.sessions.map((s) => {
                const who = subjects.flatMap((type) => (s.entities[type] ?? []).map((id) => ({ type, id })));
                return (
                  <tr key={s.id} className="link" onClick={() => go("sessions", s.id)}>
                    <td className="mono">{s.id}</td>
                    <td className="wrap">
                      {who.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <span className="mono">
                          {who[0]!.id}
                          {who.length > 1 && (
                            <span className="chip warn" style={{ marginLeft: 8 }}>
                              +{who.length - 1} more
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td>
                      {s.outcome ? (
                        <span className="row" style={{ gap: 8 }}>
                          <Pill outcome={s.outcome} />
                          {s.decisions > 1 && <span className="muted mono">×{s.decisions}</span>}
                        </span>
                      ) : (
                        <span className="muted">No decision</span>
                      )}
                    </td>
                    <td style={{ width: 150 }}>
                      {s.outcome && s.risk_score !== null ? (
                        <Score value={s.risk_score} outcome={s.outcome} />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="mono muted" style={{ textAlign: "right" }}>
                      {s.events.toLocaleString()}
                    </td>
                    <td className="muted hide-md" style={{ textAlign: "right" }}>
                      {durationText(Date.parse(s.last_seen) - Date.parse(s.started))}
                    </td>
                    <td className="mono muted" style={{ textAlign: "right" }}>
                      {stamp(s.last_seen)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {list.data && shown > 0 && (
          <Pager
            page={page}
            size={size}
            total={matching}
            shown={shown}
            onPage={setPage}
            onSize={(n) => filter(() => setSize(n))}
          />
        )}
      </div>
    </>
  );
}
