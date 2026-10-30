import type { Outcome } from "../types/interfaces";

export const OUTCOMES: Outcome[] = ["approve", "step_up", "review", "block"];
export const OUTCOME_LABEL: Record<Outcome, string> = {
  approve: "Approved",
  step_up: "Step-up",
  review: "Review",
  block: "Blocked",
};
