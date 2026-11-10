import { experimentRoutes } from "./route";
import type { ExperimentsDeps } from "./types";

export { experimentJobs, runExperiment, EXPERIMENT_JOB } from "./service";
export { backtestBatch } from "./libs";

export function experimentsModule(deps: ExperimentsDeps) {
  return { routes: experimentRoutes(deps) };
}
