import { useDashboards, useEntityTypeList, useMembers, useStats } from "./useApi";

/**
 * What the workspace has done already, read from its own data. `checked` is false until
 * every answer is in, so that nothing is shown as "not done" only because it is not known yet.
 */
export function useStartProgress(workspaceId: string, pollMs: number) {
  const stats = useStats(pollMs);
  const types = useEntityTypeList();
  const boards = useDashboards();
  const team = useMembers(workspaceId, 15000);
  const done = {
    event: (stats.data?.events ?? 0) > 0,
    action: (stats.data?.actions ?? 0) > 0,
    decision: (stats.data?.decisions ?? 0) > 0,
    entity: types.data?.types.some((t) => t.definition) ?? false,
    label: types.data?.types.some((t) => t.labelled > 0) ?? false,
    dashboard: (boards.data?.dashboards.length ?? 0) > 0,
    team: (team.data?.members.length ?? 0) > 1,
  };
  const count = Object.values(done).filter(Boolean).length;
  const total = Object.keys(done).length;
  return {
    done,
    count,
    total,
    checked: !stats.isPending && !types.isPending && !boards.isPending && !team.isPending,
  };
}
