import { useEffect, useRef, useState } from "react";
import { api, type EventFilter } from "../api/data";
import type { StoredEvent } from "../types/interfaces";
import { useScope } from "./useScope";

const POLL_MS = 2000;
const MAX_SHOWN = 500;
const MAX_REMEMBERED = 5000;

/**
 * The events that arrive while `on` is true, newest first. A pause stops the requests; the
 * events that arrived in the pause come with the next request.
 */
export function useLiveEvents(filter: EventFilter, on: boolean, paused: boolean) {
  const { workspaceId, environmentId } = useScope();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [arrived, setArrived] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const cursor = useRef<string | undefined>(undefined);
  const seen = useRef(new Set<string>());
  const key = JSON.stringify([workspaceId, environmentId, filter]);

  useEffect(() => {
    cursor.current = undefined;
    seen.current = new Set();
    setEvents([]);
    setArrived(0);
    setError(null);
  }, [key, on]);

  useEffect(() => {
    if (!on || paused) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const answer = await api.eventArrivals({ ...filter, after: cursor.current });
        if (stopped) return;
        cursor.current = answer.cursor;
        // The server answers a few seconds twice, so that an event of a slow request is not lost.
        const fresh = answer.events.filter((e) => !seen.current.has(e.id));
        for (const e of fresh) seen.current.add(e.id);
        if (seen.current.size > MAX_REMEMBERED) seen.current = new Set([...seen.current].slice(-MAX_REMEMBERED / 2));
        if (fresh.length) {
          setEvents((shown) => [...fresh, ...shown].slice(0, MAX_SHOWN));
          setArrived((n) => n + fresh.length);
        }
        setError(null);
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [key, on, paused]);

  return { events, arrived, error };
}
