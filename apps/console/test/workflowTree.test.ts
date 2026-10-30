import { describe, expect, it } from "vitest";
import { layoutWorkflow, nearestAnchor } from "../src/lib/workflowLayout";
import {
  ancestorsOf,
  duplicate,
  freshId,
  insertStep,
  moveProblem,
  moveStep,
  problemsOf,
  readableBefore,
  removeStep,
  renameId,
  slotOf,
  stepOfServerProblem,
  walk,
} from "../src/lib/workflowTree";
import type { WorkflowStep } from "../src/types/interfaces";

const step = (id: string, type = "http", extra: Record<string, unknown> = {}): WorkflowStep => ({
  id,
  name: id,
  type,
  ...(type === "http" ? { url: "https://example.com" } : {}),
  ...extra,
});

const tree = (): WorkflowStep[] => [
  step("a"),
  step("big", "condition", { when: "trigger.amount > 1", then: [step("b"), step("c")], else: [] }),
  step("each", "loop", { over: "trigger.users", steps: [step("d")] }),
  step("e"),
];
const ids = (steps: WorkflowStep[]) => walk(steps).map((e) => e.step.id);

describe("the step tree", () => {
  it("inserts into the top list and into the lists of a condition and a loop", () => {
    let steps = insertStep(tree(), { parent: null, branch: "steps", index: 0 }, step("first"));
    steps = insertStep(steps, { parent: "big", branch: "else", index: 0 }, step("other"));
    steps = insertStep(steps, { parent: "each", branch: "steps", index: 1 }, step("d2"));
    expect(ids(steps)).toEqual(["first", "a", "big", "b", "c", "other", "each", "d", "d2", "e"]);
  });

  it("moves a step down and up in its list, and into another list", () => {
    // Down: the index counts the step that moves, as the canvas shows it.
    expect(ids(moveStep(tree(), "a", { parent: null, branch: "steps", index: 3 }))).toEqual([
      "big",
      "b",
      "c",
      "each",
      "d",
      "a",
      "e",
    ]);
    expect(ids(moveStep(tree(), "e", { parent: null, branch: "steps", index: 0 }))).toEqual([
      "e",
      "a",
      "big",
      "b",
      "c",
      "each",
      "d",
    ]);
    const moved = moveStep(tree(), "c", { parent: "each", branch: "steps", index: 0 });
    expect(ids(moved)).toEqual(["a", "big", "b", "each", "c", "d", "e"]);
    expect(slotOf(moved, "c")).toEqual({ parent: "each", branch: "steps", index: 0 });
  });

  it("does nothing for a move to where the step is", () => {
    const steps = tree();
    expect(moveStep(steps, "a", { parent: null, branch: "steps", index: 0 })).toBe(steps);
    expect(moveStep(steps, "a", { parent: null, branch: "steps", index: 1 })).toBe(steps);
  });

  it("does not move a step inside itself, or deeper than three levels", () => {
    expect(moveProblem(tree(), "big", { parent: "big", branch: "then", index: 0 })).toMatch(/inside itself/);
    const deep = [
      step("l1", "condition", {
        when: "true",
        then: [
          step("l2", "condition", { when: "true", then: [step("l3", "loop", { over: "[]", steps: [] })], else: [] }),
        ],
        else: [],
      }),
      step("box", "loop", { over: "[]", steps: [step("x")] }),
    ];
    expect(moveProblem(deep, "box", { parent: "l3", branch: "steps", index: 0 })).toMatch(/3 levels/);
    expect(moveProblem(deep, "x", { parent: "l3", branch: "steps", index: 0 })).toBeNull();
    expect(moveStep(deep, "box", { parent: "l3", branch: "steps", index: 0 })).toBe(deep);
  });

  it("removes a step with the steps it holds", () => {
    expect(ids(removeStep(tree(), "big"))).toEqual(["a", "each", "d", "e"]);
  });

  it("renames an id and every reference to it, and no other text", () => {
    const steps = [
      step("check", "decide", { action: "payout", entities: {} }),
      step("then", "condition", {
        when: "steps.check.output.decision == 'block' && steps.checked.output",
        then: [step("tell", "http", { body: { id: "{{ steps.check.output.decision_id }}", note: "check" } })],
        else: [],
      }),
    ];
    const renamed = renameId(steps, "check", "review");
    expect(renamed[0]!.id).toBe("review");
    expect(renamed[1]!.when).toBe("steps.review.output.decision == 'block' && steps.checked.output");
    expect((renamed[1]!.then as WorkflowStep[])[0]!.body).toEqual({
      id: "{{ steps.review.output.decision_id }}",
      note: "check",
    });
  });

  it("knows what a step can read: the steps before it, and its loops", () => {
    const steps = tree();
    expect(readableBefore(steps, "c").map((s) => s.id)).toEqual(["a", "big", "b"]);
    expect(readableBefore(steps, "e").map((s) => s.id)).toEqual(["a", "big", "each"]);
    expect(ancestorsOf(steps, "d").map((s) => s.id)).toEqual(["each"]);
    expect(ancestorsOf(steps, "a")).toEqual([]);
  });

  it("makes ids from names, and copies a step with new ids", () => {
    expect(freshId("Tell the ops team", new Set())).toBe("tell_the_ops_team");
    expect(freshId("Tell the ops team", new Set(["tell_the_ops_team"]))).toBe("tell_the_ops_team_2");
    expect(freshId("3 checks", new Set())).toBe("step_3_checks");
    const all = new Set(ids(tree()));
    const copy = duplicate(tree()[1]!, all, new Set(walk(tree()).map((e) => e.step.name)));
    expect(ids([copy]).every((id) => !ids(tree()).includes(id))).toBe(true);
  });

  it("finds the problems a person can fix before a save", () => {
    const problems = problemsOf([step("a", "http", { url: "" }), step("a", "condition", { then: [], else: [] })]);
    expect(problems.map((p) => p.message)).toEqual([
      'Another step has the id "a".',
      'Another step has the name "a".',
      '"url" is needed.',
      'Another step has the id "a".',
      'Another step has the name "a".',
      '"when" is needed.',
    ]);
    expect(problemsOf([])).toEqual([{ step: null, message: "A workflow has at least one step." }]);
  });

  it("finds the step a server problem names", () => {
    expect(stepOfServerProblem(tree(), "steps.big.then.c.url: the address to call")).toBe("c");
    expect(stepOfServerProblem(tree(), "trigger.event: the event type")).toBeNull();
  });
});

describe("the layout", () => {
  it("places every step once, with a slot on each edge into a step and at the end of each list", () => {
    const layout = layoutWorkflow(tree());
    const stepNodes = layout.nodes.filter((n) => n.kind === "step").map((n) => n.id);
    expect(stepNodes.sort()).toEqual(["a", "b", "big", "c", "d", "e", "each"]);
    const slots = layout.anchors.map((a) => `${a.slot.parent ?? "root"}:${a.slot.branch}:${a.slot.index}`).sort();
    expect(slots).toEqual(
      [
        "root:steps:0",
        "root:steps:1",
        "root:steps:2",
        "root:steps:3",
        "root:steps:4",
        "big:then:0",
        "big:then:1",
        "big:then:2",
        "big:else:0",
        "each:steps:0",
        "each:steps:1",
      ].sort(),
    );
    // The two ways of a condition are side by side, below it.
    const at = (id: string) => layout.nodes.find((n) => n.id === id)!;
    expect(at("b").x).toBeLessThan(at("big").x);
    expect(at("slot:big:else:0").x).toBeGreaterThan(at("big").x);
    expect(at("b").y).toBeGreaterThan(at("big").y);
    // Steps after a condition are below both of its ways.
    expect(at("each").y).toBeGreaterThan(at("c").y);
    // A loop's box holds its steps.
    const frame = at("frame:each");
    expect(at("d").y).toBeGreaterThan(frame.y);
    expect(at("d").y + at("d").h).toBeLessThan(frame.y + frame.h);
  });

  it("finds the nearest slot that a step may go to", () => {
    const layout = layoutWorkflow(tree());
    const end = layout.anchors.find((a) => a.slot.parent === null && a.slot.index === 4)!;
    expect(nearestAnchor(layout.anchors, { x: end.x + 5, y: end.y - 5 }, () => true)?.slot).toEqual(end.slot);
    expect(nearestAnchor(layout.anchors, { x: end.x + 5, y: end.y }, (s) => s.index !== 4)).not.toEqual(end);
    expect(nearestAnchor(layout.anchors, { x: 5000, y: 5000 }, () => true)).toBeNull();
  });
});
