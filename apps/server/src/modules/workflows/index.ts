import { workflowHookRoutes, workflowRoutes, type WorkflowsDeps } from "./route";

export function workflowsModule(deps: WorkflowsDeps) {
  return { routes: workflowRoutes(deps), hookRoutes: workflowHookRoutes(deps) };
}
export { checkModels, collectTrainingRows, saveDraft, saveWorkflow, type TrainingRow } from "./service";
export { validateWorkflow } from "./libs";
