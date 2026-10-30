import { entityName } from "../../lib/format";

export function ActionRef({ action, names }: { action: string; names: Record<string, string> }) {
  const [key = "", version] = action.split("@");
  return (
    <span className="action-ref" title={action}>
      {names[key] ?? entityName(key)}
      {version && <small>v{version}</small>}
    </span>
  );
}
