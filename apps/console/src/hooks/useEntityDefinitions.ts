import type { EntityDefinition } from "../types/interfaces";
import { useEntityTypeList } from "./useApi";

export function useEntityDefinitions(): Record<string, EntityDefinition | undefined> {
  const { data } = useEntityTypeList();
  return Object.fromEntries((data?.types ?? []).map((t) => [t.type, t.definition]));
}
