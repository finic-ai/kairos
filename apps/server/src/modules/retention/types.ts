/** What one run of the retention cleanup deleted in one workspace. */
export interface Purged {
  cases: number;
  decisions: number;
  events: number;
  labels: number;
  webhook_deliveries: number;
  workflow_runs: number;
  case_items: number;
  entities: number;
  /** False when the run stopped at its time budget: the next run goes on. */
  complete: boolean;
}

/** How long a workspace keeps its history, in days: 7 to 3650. Null keeps it forever (the default). */
export type RetentionDays = number | null;

export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 3650;
