import type { EntityRef } from "../catalog/types";

/** How an event came. Only one from a server can start an automatic decision: not "public". */
export type EventVia = "key" | "public" | "webhook" | "console" | "workflow";

export interface StoredEvent {
  id: string;
  type: string;
  ts: string;
  entities: Record<string, string>;
  properties: Record<string, unknown>;
  /**
   * Events with the same universal id are stages of one record: a transaction that is
   * pending, then completed, then disputed. Each stage is stored; a decision sees one record.
   */
  universal_id?: string;
  status?: string;
  session?: string;
  /** Provenance about the event: for one a workflow made, `{ workflow_run_id }`. */
  metadata?: Record<string, unknown>;
}

export interface SessionRow extends SessionSummary {
  decisions: number;
  outcome: string | null;
  risk_score: number | null;
  entities: Record<string, string[]>;
}

export interface SessionFilter {
  q?: string;
  outcome?: string;
  limit: number;
  offset: number;
}

export interface SessionSummary {
  id: string;
  started: string;
  last_seen: string;
  events: number;
}

export interface EventDetail extends StoredEvent {
  decision: { id: string; outcome: string; risk_score: number } | null;
}

export interface EventsRepository {
  findEvent(workspaceId: string, environmentId: string, id: string): Promise<EventDetail | null>;
  /** `now` is when the server got the events, which is not when they happened: their `created`. Usage counts by it. */
  insertEvents(
    workspaceId: string,
    environmentId: string,
    events: StoredEvent[],
    now: string,
    via?: EventVia,
  ): Promise<{ accepted: number; duplicates: number; ids: string[] }>;
  undecidedEvents(
    workspaceId: string,
    environmentId: string,
    type: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<StoredEvent[]>;
  timeline(
    workspaceId: string,
    environmentId: string,
    entity: EntityRef,
    limit: number,
    until: string,
  ): Promise<StoredEvent[]>;
  listSessions(
    workspaceId: string,
    environmentId: string,
    filter: SessionFilter,
  ): Promise<{ sessions: SessionRow[]; total: number }>;
  sessionsOf(workspaceId: string, environmentId: string, entity: EntityRef, limit: number): Promise<SessionSummary[]>;
  eventsOfTypes(
    workspaceId: string,
    environmentId: string,
    entity: EntityRef,
    types: string[],
    since: string | null,
    until: string,
    limit: number,
  ): Promise<StoredEvent[]>;
}
