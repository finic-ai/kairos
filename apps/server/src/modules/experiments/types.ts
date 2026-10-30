import type { Executor } from "../../platform/database";

export interface ExperimentsDeps {
  db: Executor;
  now: () => Date;
  /** Starts the worker on the experiment's job at once, rather than at its next tick. */
  wake?: () => void;
}
