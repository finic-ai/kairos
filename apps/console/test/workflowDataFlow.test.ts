import { describe, expect, it } from "vitest";
import { dataFlows } from "../src/lib/workflowDataFlow";

describe("data flow", () => {
  const steps = [
    {
      id: "ask",
      name: "Read the order",
      type: "ask",
      data: { email: "{{ trigger.properties.email }}", items: "{{ trigger.properties.skus }}" },
      questions: {},
    },
    {
      id: "score",
      name: "Score",
      type: "score",
      features: {
        amount: "{{ trigger.properties.amount }}",
        express: "{{ trigger.properties.shipping_method == 'Overnight' ? 1 : 0 }}",
        hardship: "{{ steps.ask.output.hardship.probability }}",
        bias: 1,
      },
    },
    {
      id: "risk",
      name: "Risk",
      type: "condition",
      when: "steps.score.output.score >= 0.5",
      then: [{ id: "answer", name: "Answer", type: "answer", value: {} }],
    },
  ];

  it("draws what a score step reads from the trigger and from the ask step, apart", () => {
    expect(dataFlows(steps)).toEqual([
      {
        id: "data:trigger->ask",
        source: "trigger",
        target: "ask",
        fields: ["email", "items"],
        label: "2 fields from the trigger",
      },
      {
        id: "data:trigger->score",
        source: "trigger",
        target: "score",
        fields: ["amount", "express"],
        label: "2 fields from the trigger",
      },
      { id: "data:ask->score", source: "ask", target: "score", fields: ["hardship"], label: "1 answer" },
    ]);
  });

  it("does not draw a read of a step that comes later, or a constant", () => {
    const backwards = [{ id: "score", name: "S", type: "score", features: { x: "{{ steps.later.output.x }}", y: 2 } }];
    expect(dataFlows(backwards)).toEqual([]);
  });
});
