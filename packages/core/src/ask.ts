import type { GraysonAnswer, GraysonResponse } from "./grayson";
import type { Question } from "./questions";

/** A question that a workflow asks the model. The model answers with a value, never with text. */
export type AskQuestion =
  | { type: "yes_no"; question: string }
  | { type: "one_of" | "any_of"; question: string; options: Record<string, string> }
  | { type: "score"; question: string; levels: string[]; values?: number[] };

export type AskAnswer =
  | { value: boolean; probability: number }
  | { value: string; probabilities: Record<string, number> }
  | { values: string[]; probabilities: Record<string, number> }
  | { level: string; value: number; probabilities: number[] };

export const ASK_TYPES = ["yes_no", "one_of", "any_of", "score"] as const;
export const MAX_ASK_QUESTIONS = 75;
/** The most a step can give the model to read as its data, as JSON. */
export const MAX_ASK_DATA_BYTES = 32 * 1024;
/** Kept for the step's output beside the answers, so no question can have it as its key. */
export const ASK_RESERVED_KEYS = ["input_tokens"];

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The problems with a step's questions, each with its path under `at`. */
export function askQuestionProblems(questions: unknown, at: string): string[] {
  if (!isObject(questions) || Object.keys(questions).length === 0)
    return [`${at}: at least one question, by its key, such as { "takeover": { "type": "yes_no", … } }`];
  const problems: string[] = [];
  const entries = Object.entries(questions);
  if (entries.length > MAX_ASK_QUESTIONS) problems.push(`${at}: at most ${MAX_ASK_QUESTIONS} questions`);
  for (const [key, raw] of entries) {
    const where = `${at}.${key}`;
    if (!KEY.test(key) || ASK_RESERVED_KEYS.includes(key)) problems.push(`${where}: a key of letters, digits and _`);
    if (!isObject(raw)) {
      problems.push(`${where}: a question is an object`);
      continue;
    }
    if (!(ASK_TYPES as readonly string[]).includes(String(raw.type)))
      problems.push(`${where}.type: ${ASK_TYPES.join(", ")}`);
    if (typeof raw.question !== "string" || !raw.question.trim()) problems.push(`${where}.question: the question`);
    if (raw.type === "one_of" || raw.type === "any_of") {
      const options = raw.options;
      if (!isObject(options) || Object.keys(options).length < 2)
        problems.push(`${where}.options: at least two options, as { "key": "what it means" }`);
      else if (Object.entries(options).some(([k, v]) => !KEY.test(k) || typeof v !== "string" || !v.trim()))
        problems.push(`${where}.options: keys of letters, digits and _, each with what it means`);
    }
    if (raw.type === "score") {
      const levels = raw.levels;
      if (!Array.isArray(levels) || levels.length < 2 || levels.some((l) => typeof l !== "string" || !l.trim()))
        problems.push(`${where}.levels: at least two levels, from the lowest, such as ["low", "medium", "high"]`);
      else if (
        raw.values !== undefined &&
        (!Array.isArray(raw.values) ||
          raw.values.length !== levels.length ||
          raw.values.some((v) => typeof v !== "number"))
      )
        problems.push(`${where}.values: one number for each level`);
    }
  }
  return problems;
}

export function toModelQuestions(questions: Record<string, AskQuestion>): Record<string, Question> {
  return Object.fromEntries(
    Object.entries(questions).map(([key, q]): [string, Question] => {
      if (q.type === "yes_no") return [key, { type: "noul", instructions: q.question }];
      if (q.type === "score")
        return [
          key,
          { type: "score", instructions: q.question, levels: q.levels, ...(q.values ? { values: q.values } : {}) },
        ];
      return [
        key,
        { type: q.type === "one_of" ? "choice" : "multi_choice", instructions: q.question, options: q.options },
      ];
    }),
  );
}

function answerOf(answer: GraysonAnswer | undefined, key: string): AskAnswer {
  if (!answer) throw new Error(`the model gave no answer to "${key}"`);
  switch (answer.type) {
    case "noul":
      return { value: answer.value, probability: answer.probability };
    case "choice":
      return { value: answer.value, probabilities: answer.probabilities };
    case "multi_choice":
      return { values: answer.values, probabilities: answer.probabilities };
    case "score":
      return { level: answer.level, value: answer.value, probabilities: answer.probabilities };
  }
}

export function fromModelAnswers(
  questions: Record<string, AskQuestion>,
  response: GraysonResponse,
): Record<string, AskAnswer> {
  return Object.fromEntries(Object.keys(questions).map((key) => [key, answerOf(response.answers[key], key)]));
}
