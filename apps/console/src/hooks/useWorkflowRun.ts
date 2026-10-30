import { useEffect, useMemo, useState } from "react";
import { workflows } from "../api/index";
import { RUN_OPEN } from "../lib/workflows";
import type { WorkflowRun } from "../types/interfaces";
import { useApi } from "./useApi";
import type { RunMark } from "./useWorkflowCanvas";

const WORST = ["failed", "waiting", "running", "done"];

/** What a run did at each step, for the canvas. A step in a loop has one entry for each item. */
export function marksOf(run: WorkflowRun | undefined): Map<string, RunMark> {
  const marks = new Map<string, RunMark>();
  for (const entry of run?.steps ?? []) {
    const mark = marks.get(entry.id);
    if (!mark) marks.set(entry.id, { status: entry.status, count: 1 });
    else {
      mark.count++;
      if (WORST.indexOf(entry.status) < WORST.indexOf(mark.status)) mark.status = entry.status;
    }
  }
  return marks;
}

/** A run, asked for again every two seconds while it can still change. */
export function useWorkflowRun(id: string | null) {
  const [open, setOpen] = useState(true);
  const query = useApi(["workflow-run", id], () => workflows.run(id!), {
    enabled: !!id,
    refetchInterval: open ? 2000 : false,
  });
  const run = id ? query.data : undefined;
  useEffect(() => {
    setOpen(true);
  }, [id]);
  useEffect(() => {
    if (run) setOpen(RUN_OPEN.includes(run.status));
  }, [run]);
  const marks = useMemo(() => marksOf(run), [run]);
  return { run, marks, error: query.error, refetch: query.refetch };
}
