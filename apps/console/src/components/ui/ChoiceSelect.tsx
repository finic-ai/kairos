import { useState } from "react";

const OTHER = "\u0000other";

/**
 * A select of the known values. With `other`, its last choice opens a text field for a value
 * that is not known yet, such as an event type no one has sent. A value that is not in the
 * list stays a choice, so an old value is never lost.
 */
export function ChoiceSelect({
  value,
  options,
  onChange,
  placeholder = "Choose…",
  other,
  mono,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** The label of the choice that opens the text field, such as "Another event type…". */
  other?: string;
  mono?: boolean;
}) {
  const known = [...new Set(options.filter(Boolean))].sort();
  // The text field shows for a value that is not a choice, and after "other" is picked, until a choice is.
  const [picked, setPicked] = useState(false);
  const typing = !!other && (picked || (value !== "" && !known.includes(value)));
  return (
    <>
      <select
        className={`input ${mono ? "mono" : ""}`}
        value={typing ? OTHER : value}
        onChange={(e) => {
          const chosen = e.target.value;
          setPicked(chosen === OTHER);
          onChange(chosen === OTHER ? "" : chosen);
        }}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {known.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {!other && value && !known.includes(value) && <option value={value}>{value}</option>}
        {other && <option value={OTHER}>{other}</option>}
      </select>
      {typing && (
        <input
          className={`input ${mono ? "mono" : ""}`}
          autoFocus
          placeholder="Type it"
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      )}
    </>
  );
}
