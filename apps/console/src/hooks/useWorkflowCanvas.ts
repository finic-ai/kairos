import { createContext, useContext } from "react";
import type { WorkflowDraft } from "../types/interfaces";
import type { Slot } from "../lib/workflowTree";

/** What a run did at a step: its status, and how many times it ran (more than once in a loop). */
export interface RunMark {
  status: string;
  count: number;
}

export interface WorkflowCanvasState {
  editable: boolean;
  trigger: WorkflowDraft["trigger"];
  /** "trigger", a step id, or null. */
  selected: string | null;
  /** The slot a dragged step would go to. */
  hot: string | null;
  /** True while a step is dragged, from the list or on the canvas: every slot shows. */
  dragging: boolean;
  problems: Map<string, string[]>;
  marks: Map<string, RunMark>;
  onAddAt: (slot: Slot) => void;
}

export const WorkflowCanvasContext = createContext<WorkflowCanvasState | null>(null);

export function useWorkflowCanvas(): WorkflowCanvasState {
  const state = useContext(WorkflowCanvasContext);
  if (!state) throw new Error("useWorkflowCanvas is used outside the workflow canvas");
  return state;
}
