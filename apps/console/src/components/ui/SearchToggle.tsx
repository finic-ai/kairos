import { useState } from "react";

export function SearchToggle({
  value,
  label,
  placeholder,
  onChange,
}: {
  value: string;
  label: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(value !== "");
  const [opened, setOpened] = useState(false);
  const close = () => {
    onChange("");
    setOpen(false);
  };
  if (!open)
    return (
      <button
        type="button"
        className="search-toggle-button"
        aria-label={label}
        title={label}
        onClick={() => (setOpen(true), setOpened(true))}
      >
        <svg viewBox="0 0 20 20">
          <circle cx="9" cy="9" r="5" />
          <path d="m13 13 3.5 3.5" />
        </svg>
      </button>
    );
  return (
    <div className="search-toggle">
      <input
        className="input"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        autoFocus={opened}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && close()}
      />
      <button
        type="button"
        className="search-toggle-button"
        aria-label="Clear and close the search"
        title="Clear and close"
        onClick={close}
      >
        <svg viewBox="0 0 20 20">
          <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}
