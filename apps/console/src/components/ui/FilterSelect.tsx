export const FilterSelect = ({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) => (
  <select
    className={`input filter ${value ? "in-use" : ""}`}
    aria-label={label}
    value={value}
    onChange={(e) => onChange(e.target.value)}
  >
    <option value="">{label}</option>
    {options.map(([id, text]) => (
      <option key={id} value={id}>
        {text}
      </option>
    ))}
  </select>
);
