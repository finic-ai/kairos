import { Empty, Failure, Loading } from "../../components/ui/states";
import { useActions } from "../../hooks/useApi";
import { actionName, entityName, triggerText } from "../../lib/format";
import { go, href } from "../../lib/route";

export function ActionsPage() {
  const { data, error } = useActions();
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Actions</h1>
          <p className="lede">
            The decisions you want made. Each one is a question in plain language, the signals to look for, and a
            policy.
          </p>
        </div>
        <a className="btn primary" href={href("actions", "new")}>
          New action
        </a>
      </header>
      {error && <Failure message={error.message} />}
      {!data ? (
        <Loading />
      ) : data.actions.length === 0 ? (
        <div className="card">
          <Empty title="No actions yet">Define the first decision you want Kairos to make.</Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <div className="table-head">
            {data.actions.length} {data.actions.length === 1 ? "action" : "actions"}
          </div>
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Decides about</th>
                <th>Runs</th>
                <th style={{ textAlign: "right" }}>Signals</th>
                <th className="hide-md" style={{ textAlign: "right" }}>
                  Typologies
                </th>
                <th className="hide-md" style={{ textAlign: "right" }}>
                  Rules
                </th>
                <th style={{ textAlign: "right" }}>Version</th>
              </tr>
            </thead>
            <tbody>
              {data.actions.map((a) => (
                <tr key={a.name} className="link big" onClick={() => go("actions", a.name)}>
                  <td className="wrap action-cell">
                    <a className="type-name" href={href("actions", a.name)} onClick={(e) => e.stopPropagation()}>
                      {actionName(a)}
                    </a>
                    <span className="mono muted action-key">{a.name}</span>
                    <div className="note action-question">{a.hold}</div>
                  </td>
                  <td>{entityName(a.subject)}</td>
                  <td>
                    {a.trigger ? (
                      <span className="chip mono">{triggerText(a.trigger)}</span>
                    ) : (
                      <span className="muted">On request</span>
                    )}
                  </td>
                  <td className="mono muted" style={{ textAlign: "right" }}>
                    {Object.keys(a.reasons ?? {}).length}
                  </td>
                  <td className="mono muted hide-md" style={{ textAlign: "right" }}>
                    {Object.keys(a.typologies ?? {}).length}
                  </td>
                  <td className="mono muted hide-md" style={{ textAlign: "right" }}>
                    {a.policy?.rules?.length ?? 0}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <span className="chip accent">v{a.version}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
