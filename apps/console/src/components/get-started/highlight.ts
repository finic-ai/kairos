import type { HighlighterCore } from "shiki/core";

export type CodeLang = "bash" | "html" | "javascript" | "json" | "python" | "toml" | "typescript";

let loading: Promise<HighlighterCore> | undefined;

// Loaded when the first code block shows, so that the console's first bundle does not carry it.
const highlighter = () =>
  (loading ??= Promise.all([import("shiki/core"), import("shiki/engine/javascript")]).then(
    ([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
        langs: [
          import("shiki/langs/bash.mjs"),
          import("shiki/langs/html.mjs"),
          import("shiki/langs/javascript.mjs"),
          import("shiki/langs/json.mjs"),
          import("shiki/langs/python.mjs"),
          import("shiki/langs/toml.mjs"),
          import("shiki/langs/typescript.mjs"),
        ],
        engine: createJavaScriptRegexEngine(),
      }),
  ));

export async function highlight(code: string, lang: CodeLang): Promise<string> {
  return (await highlighter()).codeToHtml(code, {
    lang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
}
