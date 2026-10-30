import { useMemo } from "react";
import { actionName } from "../lib/format";
import { useActions } from "./useApi";

/**
 * The action of a decision, for people: "bank_transfer@2" → Bank Transfer, with the version
 * beside it. The names come from the defined actions; a key with no action is shown in title case.
 */
export function useActionNames(): Record<string, string> {
  const { data } = useActions();
  return useMemo(() => Object.fromEntries((data?.actions ?? []).map((a) => [a.name, actionName(a)])), [data]);
}
