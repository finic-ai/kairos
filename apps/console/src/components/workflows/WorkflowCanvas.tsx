import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { WorkflowCanvasContext, type RunMark, type WorkflowCanvasState } from "../../hooks/useWorkflowCanvas";
import { dataFlows } from "../../lib/workflowDataFlow";
import { draggedStep, STEP_DRAG_TYPE } from "../../lib/workflowDrag";
import { layoutWorkflow, nearestAnchor, type Layout, type LayoutEdge } from "../../lib/workflowLayout";
import { moveProblem, slotDepth, slotKey, slotOf, MAX_DEPTH, type Slot } from "../../lib/workflowTree";
import type { WorkflowDraft } from "../../types/interfaces";
import { EDGE_TYPES, NODE_TYPES } from "./CanvasParts";

export interface WorkflowCanvasProps {
  definition: Pick<WorkflowDraft, "trigger" | "steps">;
  editable?: boolean;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  onAddAt?: (slot: Slot) => void;
  onDropNew?: (type: string, slot: Slot) => void;
  onMove?: (id: string, slot: Slot) => void;
  onRefuse?: (message: string) => void;
  problems?: Map<string, string[]>;
  marks?: Map<string, RunMark>;
}

const CONTAINERS = new Set(["condition", "loop"]);

/** A canvas that is only read shows no "+": the ends of lists and the lines to them go. */
const endsOf = (layout: Layout) => new Set(layout.nodes.filter((n) => n.kind === "slot" && !n.empty).map((n) => n.id));

const toNodes = (layout: Layout, editable: boolean): Node[] =>
  layout.nodes
    .filter((n) => editable || !endsOf(layout).has(n.id))
    .map((n) => ({
      id: n.id,
      type: n.kind,
      position: { x: n.x, y: n.y },
      width: n.w,
      height: n.h,
      draggable: editable && n.kind === "step",
      selectable: false,
      ...(n.kind === "frame" ? { zIndex: -1 } : {}),
      data:
        n.kind === "step"
          ? { step: n.step }
          : n.kind === "slot"
            ? { slot: n.slot, empty: n.empty }
            : n.kind === "frame"
              ? { label: "For each item" }
              : {},
    }));

/**
 * Without its "+" ends, a canvas that is only read joins each line around them: the line out of
 * an end starts where the line into it started, so a branch still meets the step after it.
 */
function readOnlyEdges(layout: Layout): LayoutEdge[] {
  const ends = endsOf(layout);
  const into = new Map(layout.edges.filter((e) => ends.has(e.target)).map((e) => [e.target, e]));
  const origin = (id: string): LayoutEdge | undefined => {
    const edge = into.get(id);
    return edge && ends.has(edge.source) ? origin(edge.source) : edge;
  };
  return layout.edges
    .filter((e) => !ends.has(e.target))
    .flatMap((e) => {
      if (!ends.has(e.source)) return [e];
      const first = origin(e.source);
      return first
        ? [{ ...e, id: `${first.source}->${e.target}`, source: first.source, label: e.label ?? first.label }]
        : [];
    });
}

const toEdges = (layout: Layout, editable: boolean): Edge[] =>
  (editable ? layout.edges : readOnlyEdges(layout)).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "insert",
    data: { label: e.label, slot: e.slot, dashed: e.dashed },
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  }));

const DATA_FLOW_KEY = "kairos.canvas.dataFlow";

function readShowData(): boolean {
  try {
    return localStorage.getItem(DATA_FLOW_KEY) !== "off";
  } catch {
    return true;
  }
}

function stepOrder(steps: Pick<WorkflowDraft, "steps">["steps"], into = new Map<string, number>()) {
  for (const step of steps) {
    into.set(step.id, into.size);
    for (const key of ["then", "else", "steps"])
      if (Array.isArray(step[key])) stepOrder(step[key] as Pick<WorkflowDraft, "steps">["steps"], into);
  }
  return into;
}

/** The shortest lines take the inner lanes, so a longer line passes outside their labels. */
function toDataEdges(steps: Pick<WorkflowDraft, "steps">["steps"]): Edge[] {
  const order = stepOrder(steps);
  const at = (id: string) => (id === "trigger" ? -1 : (order.get(id) ?? 0));
  return dataFlows(steps)
    .map((f) => ({ f, span: at(f.target) - at(f.source) }))
    .sort((a, b) => a.span - b.span || at(a.f.target) - at(b.f.target))
    .map(({ f }, lane) => ({
      id: f.id,
      source: f.source,
      target: f.target,
      sourceHandle: "data-out",
      targetHandle: "data-in",
      type: "data",
      data: { label: f.label, fields: f.fields, lane },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: "var(--dataflow)" },
    }));
}

const pointOf = (event: { clientX: number; clientY: number } | TouchEvent | MouseEvent) =>
  "touches" in event
    ? { x: event.touches[0]?.clientX ?? 0, y: event.touches[0]?.clientY ?? 0 }
    : { x: event.clientX, y: event.clientY };

function Canvas({
  definition,
  editable = false,
  selected = null,
  onSelect,
  onAddAt,
  onDropNew,
  onMove,
  onRefuse,
  problems,
  marks,
}: WorkflowCanvasProps) {
  const flow = useReactFlow();
  const layout = useMemo(() => layoutWorkflow(definition.steps), [definition.steps]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(toNodes(layout, editable));
  const [showData, setShowData] = useState(readShowData);
  const toggleData = () =>
    setShowData((on) => {
      try {
        localStorage.setItem(DATA_FLOW_KEY, on ? "off" : "on");
      } catch {
        // A blocked store only means the choice is not remembered.
      }
      return !on;
    });
  const edges = useMemo(
    () => [...toEdges(layout, editable), ...(showData ? toDataEdges(definition.steps) : [])],
    [layout, editable, showData, definition.steps],
  );
  const [hot, setHot] = useState<Slot | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  useEffect(() => {
    setNodes(toNodes(layout, editable));
    // A read-only canvas can mount before its box has a size, when fitView sees nothing to fit.
    if (editable) return;
    const frame = requestAnimationFrame(() => void flow.fitView({ padding: 0.25, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [layout, editable, setNodes, flow]);

  // A step that is chosen or added out of sight comes into view.
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = selected && layout.nodes.find((n) => n.id === selected);
    const box = wrapper.current?.getBoundingClientRect();
    if (!node || !box) return;
    const topLeft = flow.flowToScreenPosition({ x: node.x, y: node.y });
    const bottomRight = flow.flowToScreenPosition({ x: node.x + node.w, y: node.y + node.h });
    const margin = 24;
    const seen =
      topLeft.x >= box.left + margin &&
      topLeft.y >= box.top + margin &&
      bottomRight.x <= box.right - margin &&
      bottomRight.y <= box.bottom - margin;
    if (!seen) void flow.setCenter(node.x + node.w / 2, node.y + node.h / 2, { zoom: flow.getZoom(), duration: 250 });
  }, [selected, layout, flow]);

  const steps = definition.steps;
  const fitsNew = useCallback(
    (type: string) => (slot: Slot) => slotDepth(steps, slot) + (CONTAINERS.has(type) ? 1 : 0) <= MAX_DEPTH,
    [steps],
  );
  /** A slot the dragged step may move to: not inside itself, not too deep, and not where it is. */
  const fitsMove = useCallback(
    (id: string) => {
      const from = slotOf(steps, id);
      return (slot: Slot) => {
        if (moveProblem(steps, id, slot)) return false;
        const same = from && from.parent === slot.parent && from.branch === slot.branch;
        return !(same && (slot.index === from.index || slot.index === from.index + 1));
      };
    },
    [steps],
  );
  const anchorAt = (screen: { x: number; y: number }, allowed: (slot: Slot) => boolean) =>
    nearestAnchor(layout.anchors, flow.screenToFlowPosition(screen), allowed)?.slot ?? null;

  const isStepDrag = (event: DragEvent) => event.dataTransfer.types.includes(STEP_DRAG_TYPE);
  const onDragOver = (event: DragEvent) => {
    if (!editable || !isStepDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
    setHot(anchorAt(pointOf(event), fitsNew(draggedStep() ?? "")));
  };
  const onDragLeave = (event: DragEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null))
      (setHot(null), setDragging(false));
  };
  const onDrop = (event: DragEvent) => {
    if (!editable || !isStepDrag(event)) return;
    event.preventDefault();
    const type = event.dataTransfer.getData(STEP_DRAG_TYPE);
    const slot = anchorAt(pointOf(event), fitsNew(type));
    setHot(null);
    setDragging(false);
    if (slot) onDropNew?.(type, slot);
    else if (anchorAt(pointOf(event), () => true)) onRefuse?.(`Conditions and loops nest at most ${MAX_DEPTH} levels.`);
    else onRefuse?.("Drop the step on a + between two steps, or at the end of a list.");
  };

  const state: WorkflowCanvasState = {
    editable,
    trigger: definition.trigger,
    selected,
    hot: hot && slotKey(hot),
    dragging,
    problems: problems ?? new Map(),
    marks: marks ?? new Map(),
    onAddAt: (slot) => onAddAt?.(slot),
  };

  return (
    <WorkflowCanvasContext.Provider value={state}>
      <div ref={wrapper} className="wf-canvas" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          nodesConnectable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          panOnScroll
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          minZoom={0.25}
          maxZoom={1.75}
          onNodeClick={(_, node) => {
            if (node.type === "trigger" || node.type === "step") onSelect?.(node.id);
          }}
          onPaneClick={() => onSelect?.(null)}
          onNodeDragStart={(_, node) => {
            setDragId(node.id);
            setDragging(true);
          }}
          onNodeDrag={(event, node) => setHot(anchorAt(pointOf(event), fitsMove(node.id)))}
          onNodeDragStop={(event, node) => {
            const slot = anchorAt(pointOf(event), fitsMove(node.id));
            setHot(null);
            setDragging(false);
            setDragId(null);
            // The tree decides where steps are: the dragged card goes back, or the step moves.
            setNodes(toNodes(layout, editable));
            if (slot) onMove?.(node.id, slot);
            else {
              const near = anchorAt(pointOf(event), () => true);
              const problem = near && moveProblem(steps, node.id, near);
              if (problem) onRefuse?.(problem);
            }
          }}
          className={dragId ? "moving" : undefined}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
          <Panel position="top-right">
            <button
              type="button"
              className={`wf-data-toggle ${showData ? "on" : ""}`}
              onClick={toggleData}
              aria-pressed={showData}
              title="Show what each step reads from the trigger and from earlier steps"
            >
              <span className="wf-data-swatch" />
              Data flow
            </button>
          </Panel>
          {editable && (
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              className="wf-minimap"
              style={{ width: 150, height: 100 }}
            />
          )}
        </ReactFlow>
      </div>
    </WorkflowCanvasContext.Provider>
  );
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
