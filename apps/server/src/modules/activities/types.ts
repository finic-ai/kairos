import type { ActivitySource } from "../../db/schema";

/** One thing a person did, as the API shows it. */
export interface ActivityView {
  id: string;
  /** "<resource>.<verb>": "api_key.created". */
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown>;
  /** Null for a change to the workspace itself. */
  environment_id: string | null;
  source: ActivitySource;
  /** Null once the person deleted their account. */
  user: { id: string; name: string; email: string } | null;
  created: string;
}

export interface ActivityPage {
  activities: ActivityView[];
  /** The id to pass as `after` for the next page. Null on the last page. */
  next: string | null;
}
