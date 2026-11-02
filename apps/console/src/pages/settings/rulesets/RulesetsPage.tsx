import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { rulesets } from "../../../api/index";
import { TemplateModal } from "../../../components/ui/TemplateModal";
import { Pager } from "../../../components/ui/Pager";
import { SearchToggle } from "../../../components/ui/SearchToggle";
import { Empty, Failure, Loading } from "../../../components/ui/states";
import { useApi } from "../../../hooks/useApi";
import { stamp } from "../../../lib/format";
import { go, href } from "../../../lib/route";
import { OUTCOME_LABEL, rulesetStatus } from "../../../lib/rulesets";

const CATEGORIES = ["Payments", "Accounts", "Identity", "Commerce", "Lending"];
const categoryRank = (category?: string) => {
  const at = CATEGORIES.indexOf(category ?? "");
  return at < 0 ? CATEGORIES.length : at;
};

export function RulesetsPage() {
  const navigate = useNavigate();
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [picking, setPicking] = useState(false);
  const [size, setSize] = useState(50);
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => (setAsked(q.trim()), setPage(1)), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const { data, error } = useApi(["rulesets", { archived, asked, size, page }], () =>
    rulesets.list({ archived, q: asked, limit: size, offset: (page - 1) * size }),
  );
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));
  useEffect(() => {
    if (data && page > pages) setPage(pages);
  }, [data, page, pages]);
  const { data: templateList } = useApi(["ruleset-templates"], () => rulesets.templates());
  const templates = templateList?.templates ?? [];
  const list = data?.rulesets ?? [];

  return (
    <>
      <header className="page-head with-actions">
        <div>
          <h1>Rulesets</h1>
          <p className="lede">Rules that approve or reject an input.</p>
        </div>
        <div className="row">
          <button type="button" className="btn primary" onClick={() => setPicking(true)}>
            New ruleset
          </button>
        </div>
      </header>
      {error && <Failure message={error.message} />}
      <div className="filters">
        <div className="seg">
          <button className={archived ? "" : "on"} onClick={() => (setArchived(false), setPage(1))}>
            All
          </button>
          <button className={archived ? "on" : ""} onClick={() => (setArchived(true), setPage(1))}>
            Archived
          </button>
        </div>
      </div>
      <div className="card table-wrap">
        <div className="table-head">
          <span>
            {!data
              ? "Loading…"
              : `${total.toLocaleString()} ${total === 1 ? "ruleset" : "rulesets"}${asked ? " matching" : ""}`}
          </span>
          <SearchToggle value={q} label="Search rulesets" placeholder="Part of a name or slug" onChange={setQ} />
        </div>
        {!data ? (
          <Loading />
        ) : list.length === 0 ? (
          asked ? (
            <Empty title="No rulesets match">Change the search.</Empty>
          ) : archived ? (
            <Empty title="No archived rulesets" />
          ) : (
            <Empty title="No rulesets yet">Start from a template or from scratch.</Empty>
          )
        ) : (
          <table>
            <thead>
              <tr>
                <th>Ruleset</th>
                <th style={{ textAlign: "right" }}>Rules</th>
                <th>When no rule matches</th>
                <th>Status</th>
                <th>Changed</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const shown = r.draft ?? r.definition;
                const status = rulesetStatus(r);
                return (
                  <tr key={r.id} className="link big" onClick={() => go("settings", "rulesets", r.slug)}>
                    <td className="wrap action-cell">
                      <a
                        className="type-name"
                        style={{ textTransform: "none" }}
                        href={href("settings", "rulesets", r.slug)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.name}
                      </a>
                      <span className="mono muted action-key">{r.slug}</span>
                      {r.description && <div className="note action-question">{r.description}</div>}
                    </td>
                    <td className="mono muted" style={{ textAlign: "right" }}>
                      {shown.rules.length}
                    </td>
                    <td>
                      <span className={`rs-outcome ${shown.default.outcome}`}>
                        {OUTCOME_LABEL[shown.default.outcome]}
                      </span>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {r.version > 0 && <span className="chip accent">v{r.version}</span>}{" "}
                      {status !== "Published" && (
                        <span className={`chip ${status === "Archived" ? "" : "warn"}`}>{status}</span>
                      )}
                    </td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>
                      {stamp(r.updated)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {data && total > 0 && (
          <Pager
            page={page}
            size={size}
            total={total}
            shown={list.length}
            onPage={setPage}
            onSize={(n) => (setSize(n), setPage(1))}
          />
        )}
      </div>

      {picking && (
        <TemplateModal
          title="New ruleset"
          options={[...templates]
            .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.name.localeCompare(b.name))
            .map((t) => ({
              id: t.slug,
              title: t.name,
              note: t.description,
              group: t.category,
              meta: `${t.definition.rules.length} ${t.definition.rules.length === 1 ? "rule" : "rules"}`,
            }))}
          scratch={{
            note: "An empty ruleset.",
            onPick: () => navigate("/settings/rulesets/new"),
          }}
          templatesNote="Rules for a common case, with tests."
          onPick={(slug) => navigate(`/settings/rulesets/new?template=${encodeURIComponent(slug)}`)}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}
