import type { ReactNode } from "react";

export function Choice({
  mark,
  title,
  note,
  meta,
  onClick,
  disabled,
}: {
  mark: ReactNode;
  title: string;
  note: string;
  meta?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="choice" onClick={onClick} disabled={disabled}>
      <span className="choice-mark" aria-hidden="true">
        {mark}
      </span>
      <span className="choice-text">
        <b>{title}</b>
        <span>{note}</span>
        {meta && <small>{meta}</small>}
      </span>
      <svg className="choice-arrow" viewBox="0 0 20 20" aria-hidden="true">
        <path d="m8 4 6 6-6 6" />
      </svg>
    </button>
  );
}
