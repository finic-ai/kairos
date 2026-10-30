import type { CopyCategory, CopySelection } from "../types/interfaces";

export const TITLES: Record<CopyCategory, string> = {
  actions: "actions",
  entities: "entities",
  events: "events",
  dashboards: "dashboards",
  queues: "queues",
  decisions: "decisions",
  models: "models",
};

export const count = (value: CopySelection) =>
  (value.ids?.length ?? 0) + (value.types?.length ?? 0) + (value.records?.length ?? 0);

export function selectionSummary(value: boolean | CopySelection, category: CopyCategory): string {
  if (typeof value === "boolean") return value ? `All ${TITLES[category]}` : "Not copied";
  const groups = [
    value.types?.length ? `${value.types.length} ${value.types.length === 1 ? "type" : "types"}` : "",
    value.records?.length ? `${value.records.length} ${value.records.length === 1 ? "entity" : "entities"}` : "",
    value.ids?.length ? `${value.ids.length} selected` : "",
  ].filter(Boolean);
  return groups.join(" · ") || "Nothing selected";
}
