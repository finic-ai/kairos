import { useState, type ReactNode } from "react";

export function CopyButton({
  text,
  label = "Copy",
  primary,
  brand,
  icon,
}: {
  text: string;
  label?: string;
  primary?: boolean;
  brand?: boolean;
  icon?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`btn ${primary ? "primary" : ""} ${brand ? "brand" : ""}`}
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))
      }
    >
      {icon}
      {copied ? "Copied" : label}
    </button>
  );
}
