import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { lists } from "../../../api/index";
import { Modal } from "../../../components/ui/Modal";
import { Pager } from "../../../components/ui/Pager";
import { SearchToggle } from "../../../components/ui/SearchToggle";
import { Empty, Failure, Loading } from "../../../components/ui/states";
import { useApi } from "../../../hooks/useApi";
import { stamp } from "../../../lib/format";
import { EditListModal, MatchFields } from "../../../components/lists/ListForms";
import { listSlugFromName, matchText } from "../../../lib/lists";
import { go, href } from "../../../lib/route";
import type { ListMatch, ListSummary } from "../../../types/interfaces";

export function ListsPage() {
  const [making, setMaking] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [size, setSize] = useState(50);
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => (setAsked(q.trim()), setPage(1)), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const { data, error } = useApi(["lists", { asked, size, page }], () =>
    lists.list({ q: asked, limit: size, offset: (page - 1) * size }),
  );
  const all = data?.lists ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));
  useEffect(() => {
    if (data && page > pages) setPage(pages);
  }, [data, page, pages]);
  const remove = async (list: ListSummary) => {
    setProblem(null);
    setNotice(null);
    if (!window.confirm(`Delete the list "${list.name}" and its ${list.item_count} items? It cannot be undone.`))
      return;
    try {
      await lists.remove(list.slug);
      setNotice(`Deleted the list "${list.name}".`);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  return (
    <>
      <header className="page-head with-actions">
        <div>
          <h1>Lists</h1>
          <p className="lede">Terms that rules check, such as domains or BINs.</p>
        </div>
        <div className="row">
          <button type="button" className="btn primary" onClick={() => setMaking(true)}>
            New list
          </button>
        </div>
      </header>
      {(problem ?? error) && <Failure message={problem ?? error!.message} />}
      {notice && <div className="banner ok">{notice}</div>}
      <div className="card table-wrap">
        <div className="table-head">
          <span>
            {!data
              ? "Loading…"
              : `${total.toLocaleString()} ${total === 1 ? "list" : "lists"}${asked ? " matching" : ""}`}
          </span>
          <SearchToggle value={q} label="Search lists" placeholder="Part of a name or slug" onChange={setQ} />
        </div>
        {!data ? (
          <Loading />
        ) : all.length === 0 && asked ? (
          <Empty title="No lists match">Change the search.</Empty>
        ) : all.length === 0 ? (
          <Empty title="No lists yet" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>List</th>
                <th>Match</th>
                <th style={{ textAlign: "right" }}>Items</th>
                <th>Changed</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {all.map((l) => (
                <tr key={l.id} className="link big" onClick={() => go("settings", "lists", l.slug)}>
                  <td className="wrap action-cell">
                    <a
                      className="type-name"
                      style={{ textTransform: "none" }}
                      href={href("settings", "lists", l.slug)}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {l.name}
                    </a>
                    <span className="mono muted action-key">{l.slug}</span>
                    {l.description && <div className="note action-question">{l.description}</div>}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{matchText(l)}</td>
                  <td className="mono muted" style={{ textAlign: "right" }}>
                    {l.item_count.toLocaleString()}
                  </td>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>
                    {stamp(l.updated)}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Edit ${l.name}`}
                      title="Edit"
                      onClick={() => setEditing(l.slug)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label={`Delete ${l.name}`}
                      title="Delete"
                      onClick={() => void remove(l)}
                    >
                      <svg viewBox="0 0 20 20" aria-hidden="true" className="rs-icon">
                        <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && total > 0 && (
          <Pager
            page={page}
            size={size}
            total={total}
            shown={all.length}
            onPage={setPage}
            onSize={(n) => (setSize(n), setPage(1))}
          />
        )}
      </div>
      {making && <NewListModal onClose={() => setMaking(false)} />}
      {editing && <EditListLoader slug={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** The edit dialog needs the items, to say how many a change of the match affects. */
function EditListLoader({ slug, onClose }: { slug: string; onClose: () => void }) {
  const { data: list } = useApi(["list", slug], () => lists.get(slug));
  return list ? <EditListModal list={list} onClose={onClose} /> : null;
}

function NewListModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [match, setMatch] = useState<ListMatch>("exact");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { data: existing } = useApi(["lists", "all"], () => lists.list({ limit: 500 }));
  const taken = existing?.lists.map((l) => l.slug) ?? [];
  const shownSlug = slugEdited ? slug : listSlugFromName(name);
  const slugProblem = !shownSlug
    ? null
    : !/^[a-z][a-z0-9_]{0,63}$/.test(shownSlug) || shownSlug.startsWith("lst_")
      ? "Lower-case letters, digits and _, starting with a letter, and not lst_."
      : taken.includes(shownSlug)
        ? "Another list has this slug."
        : null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const made = await lists.save(shownSlug, {
        name: name.trim(),
        description: description.trim() || null,
        match,
        case_sensitive: caseSensitive,
      });
      navigate(`/settings/lists/${encodeURIComponent(made.slug)}`);
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title="New list" onClose={() => !busy && onClose()}>
      <form className="modal-body" onSubmit={save}>
        {problem && <div className="banner">{problem}</div>}
        <label className="field">
          <span>Name</span>
          <input
            className="input"
            value={name}
            placeholder="Disposable email domains"
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            autoFocus
            disabled={busy}
          />
        </label>
        <label className="field">
          <span>Slug</span>
          <input
            className={`input mono ${slugProblem ? "bad" : ""}`}
            value={shownSlug}
            onChange={(e) => (setSlugEdited(true), setSlug(e.target.value.trim()))}
            disabled={busy}
          />
          <small className={slugProblem ? "bad" : undefined}>
            {slugProblem ?? "Rules use the slug. It cannot change."}
          </small>
        </label>
        <label className="field">
          <span>Description</span>
          <input
            className="input"
            value={description}
            placeholder="What the list is for"
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
          />
        </label>
        <MatchFields
          match={match}
          caseSensitive={caseSensitive}
          onChange={(m, c) => (setMatch(m ?? "exact"), setCaseSensitive(c ?? false))}
        />
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || !shownSlug || !!slugProblem}>
            {busy ? "Making…" : "Make the list"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
