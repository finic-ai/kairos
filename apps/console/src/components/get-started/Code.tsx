import { CopyButton } from "./CopyButton";

export function Code({ title, text }: { title: string; text: string }) {
  return (
    <div className="code-card">
      <div className="code-head">
        <span>{title}</span>
        <CopyButton text={text} />
      </div>
      <pre>{text}</pre>
    </div>
  );
}
