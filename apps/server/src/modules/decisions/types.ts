import type { Resolution } from "../../db/schema";
import type { EntityRef } from "../catalog/types";

export interface DecisionRecord {
  id: string;
  ts: string;
  action: string;
  subject: EntityRef;
  decision: unknown;
  context: unknown;
  raw: unknown;
  event_id?: string;
  session?: string;
  /** Absent on decisions from before it was kept. */
  request?: { entities: Record<string, string>; properties: Record<string, unknown> };
  revision?: number;
  resolution?: Resolution | null;
  final_outcome?: string;
  automatic?: boolean;
  /** Provenance about the row: for a decision a workflow made, `{ workflow_run_id, workflow_step_key }`. */
  metadata?: Record<string, unknown>;
}

export type DecisionSummary = Omit<DecisionRecord, "context" | "raw">;

export interface DecisionFilter {
  limit: number;
  before?: string;
  offset?: number;
  outcome?: string;
  final_outcome?: string;
  action?: string;
  subject?: EntityRef;
  session?: string;
}
