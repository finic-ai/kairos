export const PAGE_SIZES = [25, 50, 100, 200];

export function Pager({
  page,
  size,
  total,
  shown,
  note,
  onPage,
  onSize,
}: {
  page: number;
  size: number;
  total: number;
  shown: number;
  note?: string;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const first = (page - 1) * size + 1;
  return (
    <div className="table-foot pager">
      <span>
        {shown > 0
          ? `${first.toLocaleString()}–${(first + shown - 1).toLocaleString()} of ${total.toLocaleString()}`
          : `0 of ${total.toLocaleString()}`}
        {note ? ` · ${note}` : ""}
      </span>
      <div className="row">
        <select
          className="input"
          aria-label="Rows on a page"
          value={size}
          onChange={(e) => onSize(Number(e.target.value))}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} on a page
            </option>
          ))}
        </select>
        <button className="btn" disabled={page <= 1} onClick={() => onPage(1)} aria-label="First page">
          «
        </button>
        <button className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span className="page-of">
          Page {page.toLocaleString()} of {pages.toLocaleString()}
        </span>
        <button className="btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
        <button className="btn" disabled={page >= pages} onClick={() => onPage(pages)} aria-label="Last page">
          »
        </button>
      </div>
    </div>
  );
}
