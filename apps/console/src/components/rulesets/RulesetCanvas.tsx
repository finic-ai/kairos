import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { conditionChips, OUTCOME_LABEL } from "../../lib/rulesets";
import type { RulesetDefinition, RulesetResult, RulesetRule } from "../../types/interfaces";

export type Selection = "start" | "default" | `rule:${string}` | null;

interface CanvasState {
  editable: boolean;
  selected: Selection;
  problems: Map<string, string[]>;
  result?: RulesetResult;
  count: number;
  onSelect: (s: Selection) => void;
  onAdd: () => void;
  onMove: (id: string, by: -1 | 1) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

const Canvas = createContext<CanvasState | null>(null);
const useCanvas = () => useContext(Canvas)!;

// These sizes are the CSS of .rs-card: the canvas places each card from them, before it is drawn.
const WIDTH = 360;
const PAD = 12;
const HEAD = 40;
const GAP = 10;
const LABEL = 22;
const CHIP = 28;
const JOIN = 26;
const SPACE = 44;
const START = 64;
const ADD = 40;

const ruleHeight = (chips: number) => {
  const n = Math.max(1, chips);
  return PAD + HEAD + GAP + LABEL + n * CHIP + (n - 1) * JOIN + GAP + LABEL + CHIP + PAD;
};
const DEFAULT = PAD + HEAD + GAP + CHIP + PAD;

const handles = (
  <>
    <Handle type="target" position={Position.Top} isConnectable={false} className="wf-handle" />
    <Handle type="source" position={Position.Bottom} isConnectable={false} className="wf-handle" />
  </>
);

export function OutcomeMark({ outcome }: { outcome: RulesetRule["outcome"] }) {
  return (
    <span className={`rs-mark ${outcome}`} aria-hidden="true">
      <svg viewBox="0 0 20 20">
        {outcome === "approve" ? <path d="m5 10.5 3.2 3L15 6.5" /> : <path d="m6 6 8 8M14 6l-8 8" />}
      </svg>
    </span>
  );
}

function OutcomeChip({ outcome, response }: { outcome: RulesetRule["outcome"]; response?: unknown }) {
  return (
    <span className={`rs-chip outcome ${outcome}`}>
      <OutcomeMark outcome={outcome} />
      {OUTCOME_LABEL[outcome]}
      {response !== undefined && response !== null && <em>with a response</em>}
    </span>
  );
}

function StartNode({ data }: NodeProps<Node<{ inputs: string[] }>>) {
  const { selected, problems } = useCanvas();
  const problem = problems.get("start");
  return (
    <div className={`rs-card start ${selected === "start" ? "selected" : ""} ${problem ? "has-problem" : ""}`}>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="wf-handle" />
      <span className="rs-mark start" aria-hidden="true">
        <svg viewBox="0 0 20 20">
          <path d="M4 10h9M10 6l4 4-4 4" />
        </svg>
      </span>
      <span className="rs-card-text">
        <small>Start</small>
        <b>
          {data.inputs.length === 0
            ? "Input: any JSON object"
            : `Input: ${data.inputs.slice(0, 4).join(", ")}${data.inputs.length > 4 ? ", …" : ""}`}
        </b>
      </span>
      {problem && <span className="wf-problem">!</span>}
    </div>
  );
}

function RuleMenu({ id, index }: { id: string; index: number }) {
  const { count, onMove, onDuplicate, onDelete } = useCanvas();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  const item = (label: string, act: () => void, disabled = false, danger = false) => (
    <button
      type="button"
      className={danger ? "danger" : undefined}
      disabled={disabled}
      onClick={(e) => (e.stopPropagation(), setOpen(false), act())}
    >
      {label}
    </button>
  );
  return (
    <span className="rs-menu-wrap nodrag">
      <button
        type="button"
        className="icon-btn rs-more"
        aria-label="More"
        onClick={(e) => (e.stopPropagation(), setOpen(!open))}
      >
        ⋯
      </button>
      {open && (
        <div className="rs-menu" role="menu">
          {item("Move up", () => onMove(id, -1), index === 0)}
          {item("Move down", () => onMove(id, 1), index === count - 1)}
          {item("Duplicate", () => onDuplicate(id))}
          {item("Delete", () => onDelete(id), false, true)}
        </div>
      )}
    </span>
  );
}

function RuleNode({ data }: NodeProps<Node<{ rule: RulesetRule; index: number }>>) {
  const { selected, problems, result, editable } = useCanvas();
  const { rule, index } = data;
  const key = `rule:${rule.id}` as const;
  const problem = problems.get(key);
  const { join, chips } = conditionChips(rule.when);
  const hit = result?.rule === rule.id;
  const missing = result?.missing.includes(rule.id);
  return (
    <div
      className={`rs-card rule ${selected === key ? "selected" : ""} ${problem ? "has-problem" : ""} ${
        hit ? `hit ${rule.outcome}` : ""
      }`}
      title={problem?.join("\n")}
    >
      {handles}
      <div className="rs-card-head">
        <OutcomeMark outcome={rule.outcome} />
        <span className="rs-card-text">
          <small>{chips[0] ?? "No condition yet"}</small>
          <b>
            {index + 1}. {rule.name || "Unnamed rule"}
          </b>
        </span>
        {hit && <span className="rs-tag hit">Matched</span>}
        {missing && <span className="rs-tag">Input missing</span>}
        {problem && <span className="wf-problem">!</span>}
        {editable && <RuleMenu id={rule.id} index={index} />}
      </div>
      <div className="rs-label">If</div>
      {chips.length === 0 ? (
        <span className="rs-chip empty">Add a condition</span>
      ) : (
        chips.map((chip, i) => (
          <div key={i} className="rs-chip-row">
            {i > 0 && (
              <div className="rs-join">
                <span>{join}</span>
              </div>
            )}
            <span className="rs-chip">{chip}</span>
          </div>
        ))
      )}
      <div className="rs-label">Then</div>
      <OutcomeChip outcome={rule.outcome} response={rule.response} />
    </div>
  );
}

function AddNode() {
  const { editable, onAdd } = useCanvas();
  return (
    <div className="rs-add-wrap">
      {handles}
      {editable && (
        <button type="button" className="btn rs-add nodrag" onClick={(e) => (e.stopPropagation(), onAdd())}>
          + Add rule
        </button>
      )}
    </div>
  );
}

function DefaultNode({ data }: NodeProps<Node<{ fallback: RulesetDefinition["default"] }>>) {
  const { selected, problems, result } = useCanvas();
  const problem = problems.get("default");
  const hit = result && !result.matched;
  return (
    <div
      className={`rs-card default ${selected === "default" ? "selected" : ""} ${problem ? "has-problem" : ""} ${
        hit ? `hit ${data.fallback.outcome}` : ""
      }`}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} className="wf-handle" />
      <div className="rs-card-head">
        <span className="rs-mark end" aria-hidden="true">
          <svg viewBox="0 0 20 20">
            <path d="M5 10h10" />
          </svg>
        </span>
        <span className="rs-card-text">
          <small>Otherwise</small>
          <b>No rule matches</b>
        </span>
        {hit && <span className="rs-tag hit">Used</span>}
        {problem && <span className="wf-problem">!</span>}
      </div>
      <OutcomeChip outcome={data.fallback.outcome} response={data.fallback.response} />
    </div>
  );
}

const NODE_TYPES = { start: StartNode, rule: RuleNode, add: AddNode, fallback: DefaultNode };

function layout(definition: RulesetDefinition, editable: boolean): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  let y = 0;
  const place = (id: string, type: string, height: number, data: Record<string, unknown>) => {
    nodes.push({ id, type, position: { x: 0, y }, width: WIDTH, height, data, draggable: false, selectable: false });
    y += height + SPACE;
  };
  place("start", "start", START, { inputs: definition.inputs.map((i) => i.name) });
  definition.rules.forEach((rule, index) =>
    place(`rule:${rule.id}`, "rule", ruleHeight(conditionChips(rule.when).chips.length), { rule, index }),
  );
  if (editable) place("add", "add", ADD, {});
  place("default", "fallback", DEFAULT, { fallback: definition.default });
  const edges = nodes.slice(1).map((node, i) => ({
    id: `${nodes[i]!.id}->${node.id}`,
    source: nodes[i]!.id,
    target: node.id,
    type: "straight",
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    className: "wf-edge",
  }));
  return { nodes, edges };
}

export interface RulesetCanvasProps extends Omit<CanvasState, "count"> {
  definition: RulesetDefinition;
}

function Flow({ definition, ...state }: RulesetCanvasProps) {
  const flow = useReactFlow();
  const { nodes, edges } = useMemo(() => layout(definition, state.editable), [definition, state.editable]);
  const { selected } = state;
  const wrapper = useRef<HTMLDivElement>(null);
  // A card that is chosen or added out of sight comes into view.
  useEffect(() => {
    const node = selected && nodes.find((n) => n.id === selected);
    const box = wrapper.current?.getBoundingClientRect();
    if (!node || !box) return;
    const top = flow.flowToScreenPosition({ x: 0, y: node.position.y });
    const bottom = flow.flowToScreenPosition({ x: WIDTH, y: node.position.y + (node.height ?? 0) });
    const seen = top.x >= box.left && top.y >= box.top + 24 && bottom.x <= box.right && bottom.y <= box.bottom - 24;
    if (!seen)
      void flow.setCenter(WIDTH / 2, node.position.y + (node.height ?? 0) / 2, { zoom: flow.getZoom(), duration: 250 });
  }, [selected, nodes, flow]);
  return (
    <Canvas.Provider value={{ ...state, count: definition.rules.length }}>
      <div ref={wrapper} className="wf-canvas rs-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          nodesConnectable={false}
          nodesDraggable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          panOnScroll
          onInit={(instance) =>
            void instance.setViewport({
              x: Math.max(24, ((wrapper.current?.clientWidth ?? 0) - WIDTH) / 2),
              y: 32,
              zoom: 1,
            })
          }
          minZoom={0.3}
          maxZoom={1.5}
          onNodeClick={(_, node) => {
            if (node.type === "start") state.onSelect("start");
            else if (node.type === "fallback") state.onSelect("default");
            else if (node.type === "rule") state.onSelect(node.id as Selection);
          }}
          onPaneClick={() => state.onSelect(null)}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </div>
    </Canvas.Provider>
  );
}

export function RulesetCanvas(props: RulesetCanvasProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
