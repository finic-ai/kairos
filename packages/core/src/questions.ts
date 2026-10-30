/** A question in the format of Grayson's `POST /v1/decide`. */
export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice" | "multi_choice"; instructions: string; options: Record<string, string> }
  | { type: "score"; instructions: string; levels: string[]; values?: number[] };
