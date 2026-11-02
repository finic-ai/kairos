import type { ListMatch } from "@kairos/core";

/**
 * One item of a call that adds or replaces items. Without `match` or `case_sensitive`, or with
 * null, the item uses the list's. The server sets who added it, and when.
 */
export interface ItemInput {
  value: string | number;
  note?: string;
  match?: ListMatch | null;
  case_sensitive?: boolean | null;
}
