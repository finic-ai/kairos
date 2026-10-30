import { useEffect, useState } from "react";
import { environments } from "../../api/index";
import type { CopyCategory } from "../../types/interfaces";
import type { CopyOption, CopyOptionCategory, CopySelection } from "../../types/interfaces";
import { Modal } from "../ui/Modal";
import { count, TITLES } from "../../lib/environments";

const PAGE = 30;

export function CopySelectionModal({
  workspace,
  source,
  category,
  value,
  onApply,
  onClose,
}: {
  workspace: string;
  source: string;
  category: CopyCategory;
  value: boolean | CopySelection;
  onApply: (value: boolean | CopySelection) => void;
  onClose: () => void;
}) {
  // Opening "Choose items" starts an explicit selection. Cancel preserves the previous choice.
  const [selection, setSelection] = useState<CopySelection>(typeof value === "object" ? value : {});
  const [all, setAll] = useState(false);
  const [group, setGroup] = useState<CopyOptionCategory>(
    category === "entities" ? "entity_types" : category === "events" ? "event_types" : category,
  );
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ items: CopyOption[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setData(null);
    setError(null);
    const timer = setTimeout(
      () => {
        environments.options(workspace, source, { category: group, q: query, offset, limit: PAGE }).then(
          (next) => {
            if (active) {
              setData(next);
              setLoading(false);
            }
          },
          (cause: Error) => {
            if (active) {
              setError(cause.message);
              setLoading(false);
            }
          },
        );
      },
      query ? 200 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [workspace, source, group, query, offset, retry]);

  const checked = (item: CopyOption, selected = selection) =>
    group === "entity_types" || group === "event_types"
      ? !!selected.types?.includes(item.id)
      : group === "entities"
        ? !!selected.records?.some((r) => r.type === item.type && r.id === item.id)
        : !!selected.ids?.includes(item.id);
  const changed = (selected: CopySelection, item: CopyOption, on: boolean): CopySelection => {
    if (group === "entity_types" || group === "event_types")
      return {
        ...selected,
        types: on
          ? [...new Set([...(selected.types ?? []), item.id])]
          : (selected.types ?? []).filter((id) => id !== item.id),
      };
    if (group === "entities")
      return {
        ...selected,
        records: [
          ...(selected.records ?? []).filter((r) => r.type !== item.type || r.id !== item.id),
          ...(on ? [{ type: item.type!, id: item.id }] : []),
        ],
      };
    return {
      ...selected,
      ids: on ? [...new Set([...(selected.ids ?? []), item.id])] : (selected.ids ?? []).filter((id) => id !== item.id),
    };
  };
  const chooseGroup = (next: CopyOptionCategory) => {
    setGroup(next);
    setQuery("");
    setOffset(0);
  };
  return (
    <Modal title={`Choose ${TITLES[category]}`} onClose={onClose} wide>
      <div className="modal-body">
        <label className="check-line">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Copy all {TITLES[category]}
        </label>
        {!all && (
          <>
            {(category === "entities" || category === "events") && (
              <div className="copy-picker-tabs" role="group" aria-label="Selection level">
                <button
                  type="button"
                  className={`btn ${group.endsWith("_types") ? "primary" : ""}`}
                  onClick={() => chooseGroup(category === "entities" ? "entity_types" : "event_types")}
                >
                  By type
                </button>
                <button
                  type="button"
                  className={`btn ${!group.endsWith("_types") ? "primary" : ""}`}
                  onClick={() => chooseGroup(category)}
                >
                  Individual {TITLES[category]}
                </button>
              </div>
            )}
            <input
              className="input"
              type="search"
              aria-label={`Search ${TITLES[category]}`}
              placeholder="Search by name, type, or ID…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
              autoFocus
            />
            <div className="copy-picker-tools">
              <span>
                {count(selection)} selected{count(selection) >= 1000 ? " · Selection limit reached" : ""}
              </span>
              <button
                type="button"
                className="btn ghost"
                disabled={
                  loading ||
                  !data?.items.length ||
                  count(selection) + data.items.filter((item) => !checked(item)).length > 1000
                }
                onClick={() =>
                  setSelection((previous) => data!.items.reduce((next, item) => changed(next, item, true), previous))
                }
              >
                Select this page
              </button>
              <button type="button" className="btn ghost" disabled={!count(selection)} onClick={() => setSelection({})}>
                Clear selection
              </button>
            </div>
            <div className="copy-picker-results" aria-busy={loading}>
              {loading ? (
                <p className="muted">Loading…</p>
              ) : error ? (
                <div className="banner">
                  {error}
                  <button type="button" className="btn" onClick={() => setRetry((r) => r + 1)}>
                    Retry
                  </button>
                </div>
              ) : !data?.items.length ? (
                <p className="muted">No matching {TITLES[category]}.</p>
              ) : (
                data.items.map((item) => (
                  <label className="copy-choice-row" key={JSON.stringify([item.type, item.id])}>
                    <input
                      type="checkbox"
                      checked={checked(item)}
                      disabled={!checked(item) && count(selection) >= 1000}
                      onChange={(e) => setSelection((previous) => changed(previous, item, e.target.checked))}
                    />
                    <span>
                      <b>{item.label}</b>
                      <small>{item.detail}</small>
                    </span>
                  </label>
                ))
              )}
            </div>
            <div className="copy-picker-tools">
              <span>
                {data?.total
                  ? `${offset + 1}–${Math.min(offset + PAGE, data.total)} of ${data.total.toLocaleString()}`
                  : ""}
              </span>
              <button
                type="button"
                className="btn"
                disabled={loading || !offset}
                onClick={() => setOffset((n) => Math.max(0, n - PAGE))}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn"
                disabled={loading || !data || offset + PAGE >= data.total}
                onClick={() => setOffset((n) => n + PAGE)}
              >
                Next
              </button>
            </div>
          </>
        )}
        {category === "decisions" && (
          <p className="note">
            Only the selected decisions and their triggering events and required action versions are included. Their
            original context and resolutions are preserved.
          </p>
        )}
        {(category === "entities" || category === "events") && (
          <p className="note">
            Selecting a type includes every {category === "entities" ? "entity" : "event"} of that type. Selections
            across pages and types are kept.
          </p>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!all && !count(selection)}
            onClick={() => onApply(all ? true : selection)}
          >
            Use selection
          </button>
        </div>
      </div>
    </Modal>
  );
}
