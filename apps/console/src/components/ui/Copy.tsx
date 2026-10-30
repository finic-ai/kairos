import { useState } from "react";

export function Copy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(value).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)));
  return (
    <div className="copy-row">
      <input className="input mono" readOnly value={value} onFocus={(e) => e.target.select()} />
      <button type="button" className="btn" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
