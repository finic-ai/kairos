import { useQuery } from "@tanstack/react-query";
import { api, models, queues, webhooks, workflows, workspaces } from "../api/index";
import { useScope } from "./useScope";

/**
 * A request through the cache. The key names what is asked; the workspace and the environment
 * are added to it, so that an answer is never shown in another one.
 */
export function useApi<T>(
  key: readonly unknown[],
  load: () => Promise<T>,
  options: {
    refetchInterval?: number | false | ((query: { state: { data: T | undefined } }) => number | false);
    enabled?: boolean;
  } = {},
) {
  const { workspaceId, environmentId } = useScope();
  return useQuery({ queryKey: [workspaceId, environmentId, ...key], queryFn: load, ...options });
}

export const useActions = () => useApi(["actions"], () => api.actions());
/** The builder's model lists hold every model, up to the API's page limit. */
export const useModels = () => useApi(["models", "all"], () => models.list({ limit: 500 }));
export const useWorkflows = (archived = false) => useApi(["workflows", archived], () => workflows.list(archived));
export const useEntityTypeList = () => useApi(["entity-types"], () => api.entities({}));
export const useStats = (refetchInterval?: number) => useApi(["stats"], () => api.stats(), { refetchInterval });
export const useDashboards = () => useApi(["dashboards"], () => api.dashboards());
export const useQueues = (refetchInterval?: number) => useApi(["queues"], () => queues.list(), { refetchInterval });
export const useWebhookPresets = () => useApi(["webhook-presets"], () => webhooks.presets());
export const useMembers = (workspaceId: string, refetchInterval?: number) =>
  useApi(["members", workspaceId], () => workspaces.members(workspaceId), { refetchInterval });
