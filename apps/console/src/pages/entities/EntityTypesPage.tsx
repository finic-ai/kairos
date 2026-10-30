import { TypeIcon } from "../../components/entities/EntityIcon";
import { Empty, Failure, Loading } from "../../components/ui/states";
import { entityName, entityNames, stamp } from "../../lib/format";
import { useEntityTypeList } from "../../hooks/useApi";
import { go, href } from "../../lib/route";

export function EntityTypesPage() {
  const { data, error } = useEntityTypeList();
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Entities</h1>
          <p className="lede">
            The things your events are about. Select one to see its list. An entity exists once you define it, or once
            an event names it.
          </p>
        </div>
        <a className="btn primary" href={href("entity-types", "new")}>
          Define entity
        </a>
      </header>
      {error && <Failure message={error.message} />}
      {!data ? (
        <Loading />
      ) : data.types.length === 0 ? (
        <div className="card">
          <Empty title="No entities yet">Define an entity, or send an event that names one.</Empty>
        </div>
      ) : (
        <div className="card table-wrap">
          <div className="table-head">
            {data.types.length} {data.types.length === 1 ? "entity" : "entities"}
          </div>
          <table>
            <thead>
              <tr>
                <th>Entity</th>
                <th style={{ textAlign: "right" }}>Count</th>
                <th style={{ textAlign: "right" }}>Events</th>
                <th style={{ textAlign: "right" }}>Labelled</th>
                <th style={{ textAlign: "right" }}>Last active</th>
              </tr>
            </thead>
            <tbody>
              {data.types.map((t) => (
                <tr key={t.type} className="link big" onClick={() => go("entities", t.type)}>
                  <td>
                    <div className="type-cell">
                      <TypeIcon type={t.type} definition={t.definition} />
                      <span className="type-name">{entityNames(t.type)}</span>
                      {t.definition?.kind && (
                        <span className="chip accent" style={{ marginLeft: 10 }}>
                          {entityName(t.definition.kind)}
                        </span>
                      )}
                      {t.definition?.link === false && (
                        <span className="chip" style={{ marginLeft: 6 }}>
                          not a link
                        </span>
                      )}
                    </div>
                    {t.definition?.description && (
                      <div className="note" style={{ marginTop: 4, marginLeft: 34 }}>
                        {t.definition.description}
                      </div>
                    )}
                  </td>
                  <td className="num">{t.count.toLocaleString()}</td>
                  <td className="mono muted" style={{ textAlign: "right" }}>
                    {(t.events ?? 0).toLocaleString()}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {t.labelled ? (
                      <span className="chip warn">{t.labelled.toLocaleString()}</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="mono muted" style={{ textAlign: "right" }}>
                    {t.last_seen ? stamp(t.last_seen) : "no events"}
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
