import { useState } from "react";
import type { AskQuestion } from "@kairos/core";

type Questions = Record<string, AskQuestion>;

const KINDS: { value: AskQuestion["type"]; label: string; reads: string }[] = [
  { value: "yes_no", label: "Yes or no", reads: ".value (true or false), .probability" },
  { value: "one_of", label: "One of a list", reads: ".value (an option's key), .probabilities" },
  { value: "any_of", label: "Any of a list", reads: ".values (the keys that apply), .probabilities" },
  { value: "score", label: "A score", reads: ".level, .value (a number from 0, the first level, up)" },
];

/** "key: what it means", one option on each line. */
const optionsText = (options: Record<string, string>) =>
  Object.entries(options)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
const optionsOf = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.split(":"))
      .filter(([k]) => k?.trim())
      .map(([k, ...v]) => [k!.trim(), v.join(":").trim()]),
  );

function freshKey(questions: Questions) {
  let n = Object.keys(questions).length + 1;
  while (`question_${n}` in questions) n++;
  return `question_${n}`;
}

/** The questions of an "Ask a question" step, by their keys. The next steps read each answer by its key. */
export function QuestionsEditor({
  stepId,
  value,
  onChange,
}: {
  stepId: string;
  value: unknown;
  onChange: (questions: Questions | undefined) => void;
}) {
  const questions = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Questions;
  const entries = Object.entries(questions);
  // A list's options are kept as typed, so a line in the middle of being written is not lost.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const put = (key: string, question: AskQuestion, rename?: string) => {
    const next: Questions = {};
    for (const [k, q] of entries) next[k === key ? (rename ?? key) : k] = k === key ? question : q;
    onChange(next);
  };
  const ofKind = (q: AskQuestion, type: AskQuestion["type"]): AskQuestion =>
    type === "yes_no"
      ? { type, question: q.question }
      : type === "score"
        ? { type, question: q.question, levels: "levels" in q ? q.levels : ["low", "medium", "high"] }
        : { type, question: q.question, options: "options" in q ? q.options : { yes: "Yes", no: "No" } };

  return (
    <div className="wf-questions">
      {entries.map(([key, q]) => (
        <div key={key} className="wf-input">
          <div className="wf-input-head">
            <input
              className="input mono"
              aria-label="Question key"
              defaultValue={key}
              onBlur={(e) => {
                const to = e.target.value.trim();
                if (to && to !== key && !(to in questions)) put(key, q, to);
              }}
            />
            <select
              className="input"
              aria-label="Kind of answer"
              value={q.type}
              onChange={(e) => put(key, ofKind(q, e.target.value as AskQuestion["type"]))}
            >
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove the question ${key}`}
              title="Remove"
              onClick={() => {
                const { [key]: _gone, ...rest } = questions;
                onChange(Object.keys(rest).length ? rest : undefined);
              }}
            >
              ×
            </button>
          </div>
          <textarea
            className="input"
            rows={2}
            aria-label="Question"
            placeholder="Is someone other than the owner using this account?"
            value={q.question}
            onChange={(e) => put(key, { ...q, question: e.target.value })}
          />
          {(q.type === "one_of" || q.type === "any_of") && (
            <textarea
              className="input mono"
              rows={3}
              aria-label="Options"
              placeholder={"refund: A refund\nfraud: Fraud or a stolen card"}
              value={drafts[key] ?? optionsText(q.options)}
              onChange={(e) => {
                setDrafts({ ...drafts, [key]: e.target.value });
                put(key, { ...q, options: optionsOf(e.target.value) });
              }}
            />
          )}
          {q.type === "score" && (
            <input
              className="input mono"
              aria-label="Levels"
              placeholder="low, medium, high"
              value={q.levels.join(", ")}
              onChange={(e) =>
                put(key, {
                  ...q,
                  levels: e.target.value
                    .split(",")
                    .map((l) => l.trim())
                    .filter((l, i, all) => l || i === all.length - 1),
                })
              }
            />
          )}
          <small className="mono">
            steps.{stepId}.output.{key}
            {KINDS.find((k) => k.value === q.type)?.reads}
          </small>
        </div>
      ))}
      <button
        type="button"
        className="btn ghost wf-add-input"
        onClick={() => onChange({ ...questions, [freshKey(questions)]: { type: "yes_no", question: "" } })}
      >
        + Add a question
      </button>
      <small>
        The model answers each question with a value: yes or no, an option, or a level. It does not write text, so it
        cannot summarise or explain. Each run of the step is one call to the model.
      </small>
    </div>
  );
}
