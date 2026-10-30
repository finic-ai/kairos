export type Outcome = 0 | 1 | "already_labeled" | "outcome_unknown";

/**
 * A label at or before the row was known to the model, so the row says nothing about it. A row
 * whose window has not ended yet can still become positive.
 */
export function outcomeOf(at: Date, labelled: Date[], windowMs: number, now: Date): Outcome {
  if (labelled.some((t) => t.getTime() <= at.getTime())) return "already_labeled";
  if (labelled.some((t) => t.getTime() <= at.getTime() + windowMs)) return 1;
  return at.getTime() + windowMs > now.getTime() ? "outcome_unknown" : 0;
}

const cell = (value: string | number | null) => {
  if (value === null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const csvLine = (values: (string | number | null)[]) => values.map(cell).join(",");
