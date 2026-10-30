import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useWorkflowCanvas } from "../../hooks/useWorkflowCanvas";
import { kindOf, RUN_STATUS_LABEL, stepSummary, triggerSummary } from "../../lib/workflows";
import { slotKey, type Slot } from "../../lib/workflowTree";
import type { WorkflowStep } from "../../types/interfaces";
import { StepIcon } from "./StepIcon";

export type StepNodeData = { step: WorkflowStep };
export type SlotNodeData = { slot: Slot; empty: boolean };
export type FrameNodeData = { label: string };
export type InsertEdgeData = { label?: string; slot?: Slot; dashed?: boolean };
export type DataEdgeData = { label: string; fields: string[]; lane: number };

// Data lines leave and enter on the right, so they never sit on the run order's lines.
const dataHandles = (
  <>
    <Handle id="data-out" type="source" position={Position.Right} isConnectable={false} className="wf-handle data" />
    <Handle id="data-in" type="target" position={Position.Right} isConnectable={false} className="wf-handle data" />
  </>
);

const handles = (
  <>
    <Handle type="target" position={Position.Top} isConnectable={false} className="wf-handle" />
    <Handle type="source" position={Position.Bottom} isConnectable={false} className="wf-handle" />
    {dataHandles}
  </>
);

function TriggerNode() {
  const { trigger, selected } = useWorkflowCanvas();
  const icon =
    (["manual", "event", "record", "scheduled", "webhook", "decision"] as const).find((t) => t === trigger.type) ??
    "trigger";
  return (
    <div className={`wf-node trigger ${selected === "trigger" ? "selected" : ""}`}>
      <StepIcon icon={icon} tone="trigger" />
      <div className="wf-node-text">
        <small>Trigger</small>
        <b>{triggerSummary({ trigger })}</b>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="wf-handle" />
      {dataHandles}
    </div>
  );
}

function StepNode({ data, id }: NodeProps<Node<StepNodeData>>) {
  const { selected, problems, marks, editable } = useWorkflowCanvas();
  const kind = kindOf(data.step.type);
  const problem = problems.get(id);
  const mark = marks.get(id);
  const summary = stepSummary(data.step);
  return (
    <div
      className={`wf-node step ${selected === id ? "selected" : ""} ${problem ? "has-problem" : ""} ${
        mark ? `run-${mark.status}` : ""
      } ${editable ? "editable" : ""}`}
      title={problem?.join("\n") ?? summary}
    >
      {handles}
      <StepIcon icon={kind.icon} />
      <div className="wf-node-text">
        <small>{kind.label}</small>
        <b>{data.step.name || "Unnamed step"}</b>
      </div>
      {mark ? (
        <span className={`wf-mark ${mark.status}`}>
          {RUN_STATUS_LABEL[mark.status] ?? mark.status}
          {mark.count > 1 ? ` ×${mark.count}` : ""}
        </span>
      ) : (
        problem && (
          <span className="wf-problem" aria-label={`${problem.length} problems`}>
            !
          </span>
        )
      )}
    </div>
  );
}

function SlotNode({ data }: NodeProps<Node<SlotNodeData>>) {
  const { editable, hot, dragging, onAddAt } = useWorkflowCanvas();
  const isHot = hot === slotKey(data.slot);
  if (!editable)
    return (
      <div className={data.empty ? "wf-slot-card idle" : "wf-end"}>
        {handles}
        {data.empty ? <span className="muted">No steps</span> : null}
      </div>
    );
  return data.empty ? (
    <button
      type="button"
      className={`wf-slot-card nodrag ${isHot ? "hot" : ""} ${dragging ? "open" : ""}`}
      onClick={() => onAddAt(data.slot)}
    >
      {handles}
      <span className="wf-slot-plus">+</span>
      <span>{dragging ? "Drop the step here" : "Add a step"}</span>
    </button>
  ) : (
    <button
      type="button"
      className={`wf-plus nodrag ${isHot ? "hot" : ""} ${dragging ? "open" : ""}`}
      onClick={() => onAddAt(data.slot)}
      aria-label="Add a step here"
    >
      {handles}+
    </button>
  );
}

function JoinNode() {
  return <div className="wf-join">{handles}</div>;
}

function FrameNode({ data }: NodeProps<Node<FrameNodeData>>) {
  return (
    <div className="wf-frame">
      <span>{data.label}</span>
    </div>
  );
}

function InsertEdge({ id, sourceX, sourceY, targetX, targetY, data, markerEnd }: EdgeProps<Edge<InsertEdgeData>>) {
  const { editable, hot, dragging, onAddAt } = useWorkflowCanvas();
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Bottom,
    targetX,
    targetY,
    targetPosition: Position.Top,
  });
  const slot = data?.slot;
  const isHot = slot && hot === slotKey(slot);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className={`wf-edge ${data?.dashed ? "dashed" : ""} ${isHot ? "hot" : ""}`}
      />
      {(data?.label || (slot && editable)) && (
        <EdgeLabelRenderer>
          <div
            className="wf-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data?.label && <span className="wf-branch">{data.label}</span>}
            {slot && editable && (
              <button
                type="button"
                className={`wf-insert ${isHot ? "hot" : ""} ${dragging ? "open" : ""}`}
                onClick={() => onAddAt(slot)}
                aria-label="Add a step here"
              >
                +
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** What a step reads from the trigger or an earlier step: a dashed curve out to the right, labelled with what it carries. */
function DataEdge({ id, sourceX, sourceY, targetX, targetY, data, markerEnd }: EdgeProps<Edge<DataEdgeData>>) {
  const bulge = 60 + (data?.lane ?? 0) * 150;
  const path = `M ${sourceX} ${sourceY} C ${sourceX + bulge} ${sourceY}, ${targetX + bulge} ${targetY}, ${targetX} ${targetY}`;
  const labelX = Math.max(sourceX, targetX) + bulge * 0.75 + 12;
  const labelY = (sourceY + targetY) / 2;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} className="wf-edge data" />
      {data && (
        <EdgeLabelRenderer>
          <div
            className="wf-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            <span className="wf-data-label" title={data.fields.join("\n")}>
              {data.label}
              <em>
                {data.fields.slice(0, 2).join(", ")}
                {data.fields.length > 2 ? ", …" : ""}
              </em>
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const NODE_TYPES = { trigger: TriggerNode, step: StepNode, slot: SlotNode, join: JoinNode, frame: FrameNode };
export const EDGE_TYPES = { insert: InsertEdge, data: DataEdge };
