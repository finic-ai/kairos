import type { StoredEvent } from "../../../types";

export interface Folded extends StoredEvent {
  status_history?: { status: string; ts: string }[];
}

/**
 * Fold the stages of each record into one event, so that a transaction that was pending
 * and then completed is one transaction and not two. The folded event keeps the time and
 * the type of the first stage, the latest value of every property, and the latest status.
 * Events with no universal id pass through unchanged. Order is by first stage.
 */
export function foldRecords(events: StoredEvent[]): Folded[] {
  const out: Folded[] = [];
  const at = new Map<string, number>();
  for (const e of events) {
    const index = e.universal_id === undefined ? undefined : at.get(e.universal_id);
    if (e.universal_id === undefined || index === undefined) {
      if (e.universal_id !== undefined) at.set(e.universal_id, out.length);
      out.push({ ...e, ...(e.status ? { status_history: [{ status: e.status, ts: e.ts }] } : {}) });
      continue;
    }
    const record = out[index]!;
    record.entities = { ...record.entities, ...e.entities };
    record.properties = { ...record.properties, ...e.properties };
    if (e.status) {
      record.status = e.status;
      (record.status_history ??= []).push({ status: e.status, ts: e.ts });
    }
  }
  for (const record of out) if ((record.status_history?.length ?? 0) < 2) delete record.status_history;
  return out;
}
