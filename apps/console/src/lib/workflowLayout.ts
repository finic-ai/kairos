import type { WorkflowStep } from "../types/interfaces";
import { branchesOf, listOf, slotKey, type Branch, type Slot } from "./workflowTree";

export const NODE_W = 236;
export const NODE_H = 58;
const PLUS = 26;
const JOIN = 10;
const GAP = 56;
const BRANCH_GAP = 48;
const FRAME_PAD = 22;

export type LayoutNode =
  | { kind: "trigger"; id: "trigger"; x: number; y: number; w: number; h: number }
  | { kind: "step"; id: string; step: WorkflowStep; x: number; y: number; w: number; h: number }
  /** The end of a list: a "+", or a card when the list has no steps. */
  | { kind: "slot"; id: string; slot: Slot; empty: boolean; x: number; y: number; w: number; h: number }
  | { kind: "join"; id: string; x: number; y: number; w: number; h: number }
  /** The box behind the steps of a loop. */
  | { kind: "frame"; id: string; x: number; y: number; w: number; h: number };

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** The slot this edge leads into: a step dropped on it goes before the edge's target. */
  slot?: Slot;
  dashed?: boolean;
}

/** A point where a dragged step can be dropped, in canvas coordinates. */
export interface Anchor {
  slot: Slot;
  x: number;
  y: number;
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  anchors: Anchor[];
}

const listWidth = (list: WorkflowStep[]): number => Math.max(NODE_W, ...list.map(stepWidth));

function stepWidth(step: WorkflowStep): number {
  if (step.type === "condition")
    return Math.max(NODE_W, listWidth(listOf(step, "then")) + BRANCH_GAP + listWidth(listOf(step, "else")));
  if (step.type === "loop") return Math.max(NODE_W, listWidth(listOf(step, "steps")) + 2 * FRAME_PAD);
  return NODE_W;
}

const BRANCH_LABEL: Record<Branch, string> = { then: "if", else: "else", steps: "each" };

/**
 * Place the trigger and the steps from top to bottom. A condition puts its two lists side by
 * side, and they meet again below it; a loop puts its list in a box below it. The layout comes
 * from the tree each time, so a moved step never leaves a gap or a crossing.
 */
export function layoutWorkflow(steps: WorkflowStep[]): Layout {
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  const anchors: Anchor[] = [];
  const centre = new Map<string, { x: number; top: number; bottom: number }>();
  const place = (node: LayoutNode) => {
    nodes.push(node);
    centre.set(node.id, { x: node.x + node.w / 2, top: node.y, bottom: node.y + node.h });
  };
  const connect = (edge: LayoutEdge) => {
    edges.push(edge);
    if (edge.slot) {
      const from = centre.get(edge.source)!;
      const to = centre.get(edge.target)!;
      anchors.push({ slot: edge.slot, x: (from.x + to.x) / 2, y: (from.bottom + to.top) / 2 });
    }
  };

  /** Lay out a list from `y` down. Returns the bottom and the node the list ends with. */
  function list(
    items: WorkflowStep[],
    parent: string | null,
    branch: Branch,
    cx: number,
    top: number,
    entry: { source: string; label?: string },
  ): { bottom: number; exit: string } {
    let y = top;
    let prev = entry.source;
    let label = entry.label;
    const edgeId = (target: string) => `${prev}->${target}`;
    for (const [index, step] of items.entries()) {
      place({ kind: "step", id: step.id, step, x: cx - NODE_W / 2, y, w: NODE_W, h: NODE_H });
      connect({ id: edgeId(step.id), source: prev, target: step.id, label, slot: { parent, branch, index } });
      y += NODE_H;
      label = undefined;
      prev = step.id;
      if (step.type === "condition") {
        const [thenList, elseList] = [listOf(step, "then"), listOf(step, "else")];
        const [wThen, wElse] = [listWidth(thenList), listWidth(elseList)];
        const total = wThen + BRANCH_GAP + wElse;
        const left = list(thenList, step.id, "then", cx - total / 2 + wThen / 2, y + GAP, {
          source: step.id,
          label: BRANCH_LABEL.then,
        });
        const right = list(elseList, step.id, "else", cx + total / 2 - wElse / 2, y + GAP, {
          source: step.id,
          label: BRANCH_LABEL.else,
        });
        y = Math.max(left.bottom, right.bottom) + GAP / 2;
        const join = `join:${step.id}`;
        place({ kind: "join", id: join, x: cx - JOIN / 2, y, w: JOIN, h: JOIN });
        connect({ id: `${left.exit}->${join}`, source: left.exit, target: join });
        connect({ id: `${right.exit}->${join}`, source: right.exit, target: join });
        y += JOIN;
        prev = join;
      } else if (step.type === "loop") {
        const inner = listOf(step, "steps");
        const width = stepWidth(step);
        const frameTop = y + GAP / 2;
        const frame = `frame:${step.id}`;
        const frameIndex = nodes.length;
        const body = list(inner, step.id, "steps", cx, frameTop + FRAME_PAD, {
          source: step.id,
          label: BRANCH_LABEL.steps,
        });
        // The box goes first, so it is drawn behind the steps in it.
        nodes.splice(frameIndex, 0, {
          kind: "frame",
          id: frame,
          x: cx - width / 2,
          y: frameTop,
          w: width,
          h: body.bottom + FRAME_PAD - frameTop,
        });
        y = body.bottom + FRAME_PAD;
        prev = body.exit;
        label = "done";
      }
      y += GAP;
    }
    const end: Slot = { parent, branch, index: items.length };
    const id = `slot:${slotKey(end)}`;
    const empty = items.length === 0;
    const [w, h] = empty ? [NODE_W, NODE_H] : [PLUS, PLUS];
    place({ kind: "slot", id, slot: end, empty, x: cx - w / 2, y, w, h });
    connect({ id: edgeId(id), source: prev, target: id, label, dashed: true });
    anchors.push({ slot: end, x: cx, y: y + h / 2 });
    return { bottom: y + h, exit: id };
  }

  place({ kind: "trigger", id: "trigger", x: -NODE_W / 2, y: 0, w: NODE_W, h: NODE_H });
  list(steps, null, "steps", 0, NODE_H + GAP, { source: "trigger" });
  return { nodes, edges, anchors };
}

/** The anchor nearest to a point, within `radius`, of those `allowed` accepts. */
export function nearestAnchor(
  anchors: Anchor[],
  point: { x: number; y: number },
  allowed: (slot: Slot) => boolean,
  radius = 110,
): Anchor | null {
  let best: Anchor | null = null;
  let distance = radius;
  for (const anchor of anchors) {
    const d = Math.hypot(anchor.x - point.x, anchor.y - point.y);
    if (d < distance && allowed(anchor.slot)) ((best = anchor), (distance = d));
  }
  return best;
}
