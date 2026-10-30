import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { models } from "../../../api/index";
import { Card } from "../../../components/ui/Card";
import { PAGE_SIZES, Pager } from "../../../components/ui/Pager";
import { SearchToggle } from "../../../components/ui/SearchToggle";
import { Empty, Failure, Loading } from "../../../components/ui/states";
import { useApi } from "../../../hooks/useApi";
import { isUploaded, KIND_LABEL, metric, runtimeLabel, TRAIN_SNIPPET } from "../../../lib/models";
import { go, hashQuery, href } from "../../../lib/route";

export function ModelsPage() {
  const [, setSearchParams] = useSearchParams();
  const [q, setQ] = useState(() => hashQuery().get("q") ?? "");
  const [size, setSize] = useState(() =>
    PAGE_SIZES.includes(Number(hashQuery().get("size"))) ? Number(hashQuery().get("size")) : 50,
  );
  const [page, setPage] = useState(() => Math.max(1, Math.floor(Number(hashQuery().get("page"))) || 1));
  const [asked, setAsked] = useState(q.trim());
  useEffect(() => {
    const timer = setTimeout(() => setAsked(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const { data, error } = useApi(["models", { asked, size, page }], () =>
    models.list({ q: asked, limit: size, offset: (page - 1) * size }),
  );
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));

  useEffect(() => {
    const query = new URLSearchParams();
    if (asked) query.set("q", asked);
    if (page > 1) query.set("page", String(page));
    if (size !== 50) query.set("size", String(size));
    setSearchParams(query, { replace: true });
  }, [asked, page, size]);
  useEffect(() => {
    if (data && page > pages) setPage(pages);
  }, [data, page, pages]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Models</h1>
          <p className="lede">
            The models that workflows use. A question model, such as Grayson, reads a case and answers questions in
            plain language. A scoring model, such as an XGBoost model trained on your own outcomes, turns numbers into
            one score.
          </p>
        </div>
      </header>
      {error && <Failure message={error.message} />}
      <div className="stack">
        <div className="card table-wrap">
          <div className="table-head">
            <span>
              {!data
                ? "Loading…"
                : `${total.toLocaleString()} ${total === 1 ? "model" : "models"}${asked ? " matching" : ""}`}
            </span>
            <SearchToggle
              value={q}
              label="Search models"
              placeholder="Part of a name or slug"
              onChange={(value) => (setQ(value), setPage(1))}
            />
          </div>
          {!data ? (
            <Loading />
          ) : data.models.length === 0 ? (
            <Empty title="No models match">Change the search.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Kind</th>
                  <th style={{ textAlign: "right" }}>Features</th>
                  <th style={{ textAlign: "right", whiteSpace: "nowrap" }}>Test ROC-AUC</th>
                  <th style={{ textAlign: "right" }}>Version</th>
                </tr>
              </thead>
              <tbody>
                {data.models.map((m) => {
                  const test = isUploaded(m) ? (m.definition.metrics?.test as { roc_auc?: number } | undefined) : null;
                  return (
                    <tr key={m.slug} className="link big" onClick={() => go("settings", "models", m.slug)}>
                      <td className="wrap action-cell">
                        <a
                          className="type-name"
                          style={{ textTransform: "none" }}
                          href={href("settings", "models", m.slug)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {m.name}
                        </a>
                        <span className="mono muted action-key">{m.slug}</span>
                        {isUploaded(m) && m.definition.description && (
                          <div className="note action-question">{m.definition.description}</div>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {KIND_LABEL[m.kind]}
                        <div className="note">{runtimeLabel(m)}</div>
                      </td>
                      <td className="mono muted" style={{ textAlign: "right" }}>
                        {isUploaded(m) ? m.definition.features.length : "—"}
                      </td>
                      <td className="mono muted" style={{ textAlign: "right" }}>
                        {metric(test?.roc_auc)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {isUploaded(m) ? (
                          <span className={`chip ${m.status === "archived" ? "warn" : "accent"}`}>
                            {m.status === "archived" ? "Archived" : `v${m.version}`}
                          </span>
                        ) : (
                          <span className="chip">Built in</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {data && total > PAGE_SIZES[0]! && (
            <Pager
              page={page}
              size={size}
              total={total}
              shown={data.models.length}
              onPage={setPage}
              onSize={(n) => (setSize(n), setPage(1))}
            />
          )}
        </div>
        <Card title={data && !asked && total <= 1 ? "Add a scoring model" : "Add a version, or another model"}>
          <p className="note" style={{ marginTop: 0 }}>
            Train an XGBoost model on the runs of a workflow and the labels that came after them. The command uploads
            it, and Kairos checks that it scores the samples exactly as XGBoost did.
          </p>
          <pre>{TRAIN_SNIPPET}</pre>
          <p className="note" style={{ margin: "10px 0 0" }}>
            Then add a <b>Score with a model</b> step to a workflow.
          </p>
        </Card>
      </div>
    </>
  );
}
