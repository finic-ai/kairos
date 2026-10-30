import { useEffect, useRef, useState, type ReactNode } from "react";

/** A row of tabs that scrolls to the side, with an arrow at each end that has more. */
export function TabStrip({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const update = () => {
    const el = row.current;
    if (!el) return;
    setMore({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  };
  useEffect(() => {
    update();
    const observer = new ResizeObserver(update);
    for (const el of [row.current, ...Array.from(row.current?.children ?? [])]) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scroll = (by: number) => row.current?.scrollBy({ left: by, behavior: "smooth" });
  return (
    <div className={`tab-strip${more.left ? " more-left" : ""}${more.right ? " more-right" : ""}`}>
      {more.left && (
        <button
          type="button"
          className="tab-strip-arrow left"
          aria-label="Scroll tabs left"
          onClick={() => scroll(-240)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m12 4-6 6 6 6" />
          </svg>
        </button>
      )}
      <div
        ref={row}
        className={`seg tab-strip-row${className ? ` ${className}` : ""}`}
        role="tablist"
        aria-label={label}
        onScroll={update}
      >
        {children}
      </div>
      {more.right && (
        <button
          type="button"
          className="tab-strip-arrow right"
          aria-label="Scroll tabs right"
          onClick={() => scroll(240)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m8 4 6 6-6 6" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** A tab of a TabStrip. Selecting a tab that is partly hidden scrolls it into view. */
export function Tab({
  on,
  onSelect,
  className,
  children,
}: {
  on: boolean;
  onSelect: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      className={`${on ? "on" : ""}${className ? ` ${className}` : ""}`}
      onClick={(e) => {
        onSelect();
        e.currentTarget.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
      }}
    >
      {children}
    </button>
  );
}
