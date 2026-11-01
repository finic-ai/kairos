import { useEffect, useState } from "react";
import { CopyButton } from "./CopyButton";
import { highlight, type CodeLang } from "./highlight";

export function Code({ title, text, lang }: { title: string; text: string; lang?: CodeLang }) {
  const [html, setHtml] = useState<string>();
  useEffect(() => {
    setHtml(undefined);
    if (!lang) return;
    let current = true;
    highlight(text, lang).then(
      (out) => current && setHtml(out),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [text, lang]);
  return (
    <div className="code-card">
      <div className="code-head">
        <span>{title}</span>
        <CopyButton text={text} />
      </div>
      {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <pre>{text}</pre>}
    </div>
  );
}
