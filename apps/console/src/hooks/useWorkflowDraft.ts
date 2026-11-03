import { useCallback, useRef, useState } from "react";

const LIMIT = 100;
/** Changes with the same tag within this time are one step of undo: typing a name is one change. */
const MERGE_MS = 800;

/**
 * The workflow or ruleset being built, with undo and redo. `saved` is the version on the server: the
 * draft is dirty when it differs.
 */
export function useWorkflowDraft<T>(initial: T) {
  const [state, setState] = useState({ past: [] as T[], present: initial, future: [] as T[] });
  const [saved, setSaved] = useState(initial);
  const last = useRef<{ tag: string; at: number } | null>(null);

  const change = useCallback((next: T | ((d: T) => T), tag?: string) => {
    setState((s) => {
      const present = typeof next === "function" ? (next as (d: T) => T)(s.present) : next;
      if (present === s.present) return s;
      const now = Date.now();
      const merge = tag && last.current?.tag === tag && now - last.current.at < MERGE_MS;
      last.current = tag ? { tag, at: now } : null;
      return {
        past: merge ? s.past : [...s.past, s.present].slice(-LIMIT),
        present,
        future: [],
      };
    });
  }, []);

  const undo = useCallback(() => {
    last.current = null;
    setState((s) =>
      s.past.length ? { past: s.past.slice(0, -1), present: s.past.at(-1)!, future: [s.present, ...s.future] } : s,
    );
  }, []);

  const redo = useCallback(() => {
    last.current = null;
    setState((s) =>
      s.future.length ? { past: [...s.past, s.present], present: s.future[0]!, future: s.future.slice(1) } : s,
    );
  }, []);

  /** Start again from a definition, with no history: after a load, a save or a discard. */
  const reset = useCallback((draft: T) => {
    last.current = null;
    setSaved(draft);
    setState({ past: [], present: draft, future: [] });
  }, []);

  return {
    draft: state.present,
    saved,
    dirty: JSON.stringify(state.present) !== JSON.stringify(saved),
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    change,
    undo,
    redo,
    reset,
  };
}
