/** An on/off switch. `label` is said next to it; `title` names it for a screen reader when there is no label. */
export function Switch({
  checked,
  onChange,
  label,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : title}
      className={`switch ${checked ? "on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="track" aria-hidden>
        <span className="thumb" />
      </span>
      {label && <span className="switch-label">{label}</span>}
    </button>
  );
}
