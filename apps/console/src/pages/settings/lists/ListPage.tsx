import { useMemo, useState, type FormEvent } from "react";
import { lists } from "../../../api/index";
import { Card } from "../../../components/ui/Card";
import { Modal } from "../../../components/ui/Modal";
import { Pager } from "../../../components/ui/Pager";
import { SearchToggle } from "../../../components/ui/SearchToggle";
import { Empty, Failure, Loading } from "../../../components/ui/states";
import { useApi } from "../../../hooks/useApi";
import { stamp } from "../../../lib/format";
import { itemsFromText, MATCH_LABEL, MATCHES, matchOf, matchText } from "../../../lib/lists";
import { href } from "../../../lib/route";
import type { ListDetail, ListItem, ListMatch } from "../../../types/interfaces";
import { EditListModal, MatchFields } from "../../../components/lists/ListForms";

const MAX_ADD = 1000;

export function ListPage({ slug }: { slug: string }) {
  const { data: list, error } = useApi(["list", slug], () => lists.get(slug));
  const { data: readers } = useApi(["list-readers", slug], () => lists.readers(slug));
  const [q, setQ] = useState("");
  const [size, setSize] = useState(50);
  const [page, setPage] = useState(1);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [modal, setModal] = useState<{ kind: "add" } | { kind: "edit" } | { kind: "item"; item: ListItem } | null>(
    null,
  );

  const act = async (work: () => Promise<string | void>) => {
    setProblem(null);
    setNotice(null);
    try {
      const text = await work();
      if (text) setNotice(text);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const items = list?.items ?? [];
    return needle
      ? items.filter((i) => `${i.value} ${i.note ?? ""}`.toLowerCase().includes(needle))
      : [...items].reverse();
  }, [list, q]);

  const pages = Math.max(1, Math.ceil(shown.length / size));
  const at = Math.min(page, pages);
  const onPage = shown.slice((at - 1) * size, at * size);

  if (error) return <Failure message={error.message} />;
  if (!list) return <Loading />;
  const usedBy = [
    ...(readers?.rulesets ?? []).map((r) => ({
      kind: "Ruleset",
      label: r.name,
      href: href("settings", "rulesets", r.slug),
    })),
    ...(readers?.workflows ?? []).map((w) => ({
      kind: "Workflow",
      label: w.display_name ?? w.name,
      href: href("workflows", w.name),
    })),
  ];

  const allPicked = onPage.length > 0 && onPage.every((i) => picked.includes(i.value));
  const pick = (value: string) =>
    setPicked(picked.includes(value) ? picked.filter((p) => p !== value) : [...picked, value]);
  const removePicked = () => {
    const n = picked.length;
    if (
      !window.confirm(
        `Remove ${n} ${n === 1 ? "item" : "items"} from "${list.name}"? Each ruleset that reads it stops matching them at once.`,
      )
    )
      return;
    void act(async () => {
      const { removed } = await lists.removeItems(list.slug, picked);
      setPicked([]);
      return `Removed ${removed.toLocaleString()} ${removed === 1 ? "item" : "items"}.`;
    });
  };

  return (
    <>
      <a className="crumb" href={href("settings", "lists")}>
        ← Lists
      </a>
      <header className="page-head with-actions">
        <div>
          <h1>{list.name}</h1>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <span className="chip mono">{list.slug}</span>
            <span className="chip">{matchText(list)}</span>
            <span className="chip accent">
              {list.item_count.toLocaleString()} {list.item_count === 1 ? "item" : "items"}
            </span>
          </div>
          {list.description && <p className="lede">{list.description}</p>}
        </div>
        <div className="row">
          <button className="btn" onClick={() => setModal({ kind: "edit" })}>
            Edit
          </button>
          <button className="btn primary" onClick={() => setModal({ kind: "add" })}>
            Add items
          </button>
        </div>
      </header>
      {problem && <Failure message={problem} />}
      {notice && <div className="banner ok">{notice}</div>}

      <div className="stack">
        <div className="card table-wrap">
          {picked.length > 0 ? (
            <div className="table-head picking">
              <span className="picked">
                {picked.length.toLocaleString()} selected
                {picked.length > onPage.filter((i) => picked.includes(i.value)).length && ", also on other pages"}
              </span>
              <div className="row">
                <button className="btn danger" onClick={removePicked}>
                  Delete {picked.length.toLocaleString()} {picked.length === 1 ? "item" : "items"}
                </button>
                <button
                  className="icon-btn"
                  aria-label="Clear the selection"
                  title="Clear the selection"
                  onClick={() => setPicked([])}
                >
                  ×
                </button>
              </div>
            </div>
          ) : (
            <div className="table-head">
              <span>
                {q.trim()
                  ? `${shown.length.toLocaleString()} matching`
                  : `${list.item_count.toLocaleString()} ${list.item_count === 1 ? "item" : "items"}, newest first`}
              </span>
              <SearchToggle
                value={q}
                label="Search items"
                placeholder="Part of an item or a note"
                onChange={(value) => (setQ(value), setPage(1))}
              />
            </div>
          )}
          {shown.length === 0 ? (
            <Empty title={q.trim() ? "No items match" : "No items yet"}>
              {q.trim() ? (
                "Change the search."
              ) : (
                <button className="btn" onClick={() => setModal({ kind: "add" })}>
                  Add items
                </button>
              )}
            </Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th className="pick">
                    <input
                      type="checkbox"
                      aria-label="Select every item on this page"
                      checked={allPicked}
                      onChange={() =>
                        setPicked(
                          allPicked
                            ? picked.filter((p) => !onPage.some((i) => i.value === p))
                            : [...new Set([...picked, ...onPage.map((i) => i.value)])],
                        )
                      }
                    />
                  </th>
                  <th>Item</th>
                  <th>Match</th>
                  <th>Note</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {onPage.map((item) => {
                  const m = matchOf(list, item);
                  return (
                    <tr key={item.value} className={picked.includes(item.value) ? "picked" : undefined}>
                      <td className="pick">
                        <input
                          type="checkbox"
                          aria-label={`Select ${item.value}`}
                          checked={picked.includes(item.value)}
                          onChange={() => pick(item.value)}
                        />
                      </td>
                      <td className="mono ls-item">{item.value}</td>
                      <td>
                        {matchText(m)} {m.own ? <span className="chip">Its own</span> : null}
                      </td>
                      <td className="wrap muted ls-note">{item.note ?? ""}</td>
                      <td className="muted" style={{ whiteSpace: "nowrap" }}>
                        {item.added ? stamp(item.added) : ""}
                        {item.added_by?.startsWith("workflow:") && (
                          <div className="note ls-by" title={item.added_by}>
                            {item.added_by.slice("workflow:".length)}
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Change ${item.value}`}
                          title="Change"
                          onClick={() => setModal({ kind: "item", item })}
                        >
                          ✎
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {shown.length > 0 && (
            <Pager
              page={at}
              size={size}
              total={shown.length}
              shown={onPage.length}
              onPage={setPage}
              onSize={(n) => (setSize(n), setPage(1))}
            />
          )}
        </div>

        <Card title={`Used by · ${usedBy.length}`}>
          {usedBy.length === 0 ? (
            <p className="note" style={{ margin: 0 }}>
              No ruleset or workflow uses this list.
            </p>
          ) : (
            <div className="stack" style={{ gap: 6 }}>
              {usedBy.map((u) => (
                <a key={u.href} href={u.href}>
                  {u.label} <span className="muted">· {u.kind}</span>
                </a>
              ))}
            </div>
          )}
        </Card>
      </div>

      {modal?.kind === "add" && (
        <AddItemsModal
          list={list}
          onDone={(text) => (setModal(null), setNotice(text))}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === "edit" && <EditListModal list={list} onClose={() => setModal(null)} />}
      {modal?.kind === "item" && <EditItemModal list={list} item={modal.item} onClose={() => setModal(null)} />}
    </>
  );
}

interface Row {
  value: string;
  note: string;
  match: ListMatch | null;
  caseSensitive: boolean | null;
}

const emptyRow = (): Row => ({ value: "", note: "", match: null, caseSensitive: null });

const addedText = (result: { added: number; updated: number }) =>
  [
    `Added ${result.added.toLocaleString()} ${result.added === 1 ? "item" : "items"}.`,
    result.updated
      ? `${result.updated.toLocaleString()} ${result.updated === 1 ? "was" : "were"} on the list already, and changed.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

function AddItemsModal({
  list,
  onDone,
  onClose,
}: {
  list: ListDetail;
  onDone: (text: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"paste" | "rows">("paste");
  const [text, setText] = useState("");
  const [split, setSplit] = useState<"lines" | "commas">("lines");
  const [match, setMatch] = useState<ListMatch | null>(null);
  const [caseSensitive, setCaseSensitive] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const options = (m: ListMatch | null, c: boolean | null) => ({
    ...(m ? { match: m } : {}),
    ...(c !== null ? { case_sensitive: c } : {}),
  });
  const items =
    mode === "paste"
      ? itemsFromText(text, split).map((value) => ({
          value,
          ...options(match, caseSensitive),
          ...(note.trim() ? { note: note.trim() } : {}),
        }))
      : rows
          .filter((r) => r.value.trim())
          .map((r) => ({
            value: r.value.trim(),
            ...options(r.match, r.caseSensitive),
            ...(r.note.trim() ? { note: r.note.trim() } : {}),
          }));
  const setRow = (i: number, change: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...change } : r)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!items.length) return;
    setBusy(true);
    setProblem(null);
    try {
      onDone(addedText(await lists.addItems(list.slug, items)));
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Add items to ${list.name}`} onClose={() => !busy && onClose()} wide>
      <form className="modal-body" onSubmit={submit}>
        {problem && <div className="banner">{problem}</div>}
        <div className="seg">
          <button type="button" className={mode === "paste" ? "on" : ""} onClick={() => setMode("paste")}>
            Bulk Add
          </button>
          <button type="button" className={mode === "rows" ? "on" : ""} onClick={() => setMode("rows")}>
            Manual
          </button>
        </div>

        {mode === "paste" ? (
          <>
            <label className="field">
              <span>Items</span>
              <textarea
                className="input mono"
                rows={8}
                value={text}
                autoFocus
                placeholder={split === "lines" ? "mailinator.com\nyopmail.com" : "mailinator.com, yopmail.com"}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
              />
            </label>
            <div className="row wrap">
              <span className="note">Split at</span>
              <div className="seg tight">
                <button type="button" className={split === "lines" ? "on" : ""} onClick={() => setSplit("lines")}>
                  New lines
                </button>
                <button type="button" className={split === "commas" ? "on" : ""} onClick={() => setSplit("commas")}>
                  New lines and commas
                </button>
              </div>
              <label className="btn" style={{ marginLeft: "auto" }}>
                Open a file
                <input
                  type="file"
                  accept=".csv,.txt,text/csv,text/plain"
                  hidden
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) setText(await file.text());
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <MatchFields
              match={match}
              caseSensitive={caseSensitive}
              inherit={list}
              onChange={(m, c) => (setMatch(m), setCaseSensitive(c))}
            />
            <label className="field">
              <span>Note</span>
              <input
                className="input"
                value={note}
                maxLength={500}
                placeholder="Optional"
                onChange={(e) => setNote(e.target.value)}
                disabled={busy}
              />
            </label>
          </>
        ) : (
          <div className="ls-rows">
            <div className="ls-row head">
              <span>Item</span>
              <span>Match</span>
              <span>Case</span>
              <span>Note</span>
              <span />
            </div>
            {rows.map((row, i) => (
              <div key={i} className="ls-row">
                <input
                  className="input mono"
                  aria-label="Item"
                  value={row.value}
                  autoFocus={i === rows.length - 1}
                  placeholder="mailinator.com"
                  onChange={(e) => setRow(i, { value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && row.value.trim()) {
                      e.preventDefault();
                      setRows([...rows, { ...emptyRow(), match: row.match, caseSensitive: row.caseSensitive }]);
                    }
                  }}
                />
                <select
                  className="input"
                  aria-label="Match"
                  value={row.match ?? ""}
                  onChange={(e) => setRow(i, { match: (e.target.value || null) as ListMatch | null })}
                >
                  <option value="">The list's</option>
                  {MATCHES.map((m) => (
                    <option key={m} value={m}>
                      {MATCH_LABEL[m].label}
                    </option>
                  ))}
                </select>
                <select
                  className="input"
                  aria-label="Case"
                  value={row.caseSensitive === null ? "" : row.caseSensitive ? "yes" : "no"}
                  onChange={(e) =>
                    setRow(i, { caseSensitive: e.target.value === "" ? null : e.target.value === "yes" })
                  }
                >
                  <option value="">The list's</option>
                  <option value="no">Any case</option>
                  <option value="yes">Case sensitive</option>
                </select>
                <input
                  className="input"
                  aria-label="Note"
                  value={row.note}
                  placeholder="Note"
                  onChange={(e) => setRow(i, { note: e.target.value })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Remove the row"
                  disabled={rows.length === 1}
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="btn ghost" onClick={() => setRows([...rows, emptyRow()])}>
              + Add an item
            </button>
            <small className="muted">Enter adds a row.</small>
          </div>
        )}

        <div className="modal-foot">
          <small className="muted" style={{ marginRight: "auto" }}>
            {items.length > MAX_ADD
              ? `At most ${MAX_ADD.toLocaleString()} in one go.`
              : "Items already on the list are updated."}
          </small>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || items.length === 0 || items.length > MAX_ADD}>
            {busy
              ? "Adding…"
              : items.length
                ? `Add ${items.length.toLocaleString()} ${items.length === 1 ? "item" : "items"}`
                : "Add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditItemModal({ list, item, onClose }: { list: ListDetail; item: ListItem; onClose: () => void }) {
  const [match, setMatch] = useState<ListMatch | null>(item.match ?? null);
  const [caseSensitive, setCaseSensitive] = useState<boolean | null>(item.case_sensitive ?? null);
  const [note, setNote] = useState(item.note ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await lists.addItems(list.slug, [
        { value: item.value, match, case_sensitive: caseSensitive, ...(note.trim() ? { note: note.trim() } : {}) },
      ]);
      onClose();
    } catch (e) {
      setProblem((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={item.value} onClose={() => !busy && onClose()}>
      <form className="modal-body" onSubmit={save}>
        {problem && <div className="banner">{problem}</div>}
        <MatchFields
          match={match}
          caseSensitive={caseSensitive}
          inherit={list}
          onChange={(m, c) => (setMatch(m), setCaseSensitive(c))}
        />
        <label className="field">
          <span>Note</span>
          <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
