import { useMemo } from "react";
import { useEntityTypeList } from "./useApi";

export function useEntityTypes(): Set<string> {
  const { data } = useEntityTypeList();
  return useMemo(() => new Set((data?.types ?? []).map((t) => t.type)), [data]);
}
