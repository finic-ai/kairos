import type { WorkflowExperimentRow } from "../db/schema";
import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";
import { iso, lock } from "../platform/sql";

export interface ExperimentView {
  id: string;
  workflow: string;
  base_version: number | null;
  status: WorkflowExperimentRow["status"];
  error: string | null;
  config: Record<string, unknown>;
  dataset: Record<string, unknown> | null;
  results: Record<string, unknown>[] | null;
  best: string | null;
  selected: WorkflowExperimentRow["selected"];
  applied: WorkflowExperimentRow["applied"];
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** While a backtest runs, how far it is: never its cursor or the steps it keeps. */
function datasetView(dataset: WorkflowExperimentRow["dataset"]) {
  const state = (dataset as { backtest_state?: Record<string, unknown> } | null)?.backtest_state;
  if (!state) return dataset ?? null;
  return {
    backtest_progress: { runs: state.runs, skipped: state.skipped, requests: state.total, ran_on: state.ran_on },
  };
}

export function toExperimentView(row: WorkflowExperimentRow, withSteps = true): ExperimentView {
  return {
    id: row.id,
    workflow: row.workflow,
    base_version: row.baseVersion,
    status: row.status,
    error: row.error,
    config: row.config,
    dataset: datasetView(row.dataset),
    results: row.results ? (withSteps ? row.results : row.results.map(({ steps: _s, ...rest }) => rest)) : null,
    best: row.best,
    selected: row.selected ?? null,
    applied: row.applied ?? null,
    created_by: row.createdBy,
    created_at: iso(row.created),
    started_at: row.started ? iso(row.started) : null,
    finished_at: row.finished ? iso(row.finished) : null,
  };
}

export class WorkflowExperimentsService extends DatabaseService<"workflowExperiments"> {
  constructor(db: Executor, scope: { workspaceId: string; environmentId: string }) {
    super(db, "workflowExperiments", scope);
  }

  /** Until the transaction ends: two applies of one experiment wait for each other. */
  async lock(id: string): Promise<void> {
    await lock(this.db, "experiment", id);
  }
}
