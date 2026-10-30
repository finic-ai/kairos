import { apiHeaders } from "../api/index";
import type { DecisionSummary, Outcome } from "../types/interfaces";
import { OUTCOMES } from "./outcomes";

export type Counts = Record<Outcome, number>;

export interface OverviewData {
  events: number;
  decisions: number;
  outcomes: Counts;
  actions: number;
  entities: number;
  entity_types: number;
  labelled: number;
  sampled: number;
  series: { bucket: "hour" | "day"; points: ({ t: string } & Counts)[] };
  by_action: ({ action: string; total: number } & Counts)[];
  reasons: { code: string; count: number; held: number }[];
  histogram: number[];
  attention: DecisionSummary[];
}

export const loadOverview = async (): Promise<OverviewData> => {
  const response = await fetch("/v1/overview", { headers: apiHeaders() });
  if (!response.ok) throw new Error("The Kairos API is not reachable. Is the server running?");
  return response.json();
};

export const sum = (c: Counts) => OUTCOMES.reduce((a, o) => a + c[o], 0);
