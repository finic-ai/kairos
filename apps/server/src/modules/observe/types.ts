import type { MetricRow } from "./schema";

export interface Usage {
  days: { day: string; events: number; decisions: number; input_tokens: number }[];
  by_action: { action: string; decisions: number; input_tokens: number }[];
  by_event_type: { type: string; events: number }[];
  stored: { events: number; decisions: number; entities: number };
}

export interface WorkspaceStats {
  events: number;
  decisions: number;
  outcomes: Record<string, number>;
  actions: number;
}

export interface AnalyticsRepository {
  stats(workspaceId: string, environmentId: string): Promise<WorkspaceStats>;
  usage(workspaceId: string, environmentId: string, since: string): Promise<Usage>;
  metricRows(
    workspaceId: string,
    environmentId: string,
    source: "decisions" | "events" | "labels",
    from: string,
    to: string,
    limit: number,
    eventType?: string,
    property?: { name: string; value: string },
  ): Promise<MetricRow[]>;
  metricOptions(
    workspaceId: string,
    environmentId: string,
    eventType?: string,
  ): Promise<{
    event_types: string[];
    labels: string[];
    entity_types: string[];
    event_properties: { name: string; numeric: boolean }[];
  }>;
}
