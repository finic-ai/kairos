import { modelRoutes, type ModelsDeps } from "./route";

export { describeModel, loadScorer, parseModelRef, scoreFeatures, uploadVersion, BUILTIN_MODELS } from "./service";
export type { ScoreResult, Scorer, StepScore } from "./types";

export function modelsModule(deps: ModelsDeps) {
  return { routes: modelRoutes(deps) };
}
