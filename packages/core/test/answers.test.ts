import { describe, expect, it } from "vitest";
import { answerPaths, type AnswerStep } from "../src/answers";

const step = (id: string, type: string, more: Record<string, unknown> = {}): AnswerStep => ({
  id,
  name: id,
  type,
  ...more,
});

describe("answerPaths", () => {
  it("follows each branch of a condition, and a Return ends its path", () => {
    const paths = answerPaths([
      step("big", "condition", { then: [step("hold", "return")], else: [step("label", "record.update")] }),
      step("nap", "delay"),
      step("ok", "answer"),
    ]);
    expect(paths.answered).toBe("yes");
    expect(paths.findings.map((f) => `${f.kind} ${f.path}`)).toEqual(["delay_before_answer steps.nap"]);
    expect(paths.writesBefore).toEqual(["label"]);
  });

  it("finds an Answer in a loop, a second Answer, and paths that do not answer", () => {
    expect(answerPaths([step("each", "loop", { steps: [step("a", "answer")] })]).findings[0]!.kind).toBe(
      "answer_in_loop",
    );
    expect(answerPaths([step("a", "answer"), step("b", "answer")]).findings[0]!.kind).toBe("second_answer");
    expect(answerPaths([step("c", "condition", { then: [step("a", "answer")] })]).answered).toBe("some");
    expect(answerPaths([step("f", "filter")]).answered).toBe("no");
  });

  it("does not count a delay or a write after the answer", () => {
    const paths = answerPaths([step("a", "answer"), step("nap", "delay"), step("label", "record.update")]);
    expect(paths.findings).toEqual([]);
    expect(paths.writesBefore).toEqual([]);
  });
});
