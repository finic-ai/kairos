import { describe, expect, it } from "vitest";
import {
  caseTarget,
  dueAt,
  correlationKey,
  evaluateRule,
  highestPriority,
  needsDecision,
  ruleSentence,
  validateQueue,
  windowDays,
  type IntakeInput,
  type IntakeRule,
  type QueueDefinition,
} from "../src";

const onboarding: IntakeRule = {
  id: "held_or_risky",
  name: "Held, blocked, or risky",
  priority: "high",
  conditions: {
    any: [
      { field: "decision.outcome", op: "in", value: ["review", "step_up", "block"] },
      { field: "decision.risk_score", op: ">=", value: 80 },
      { field: "signal.identity_mismatch", op: ">=", value: 0.9 },
    ],
  },
};

const decision = (patch: Partial<NonNullable<IntakeInput["decision"]>> = {}): IntakeInput => ({
  decision: { outcome: "approve", risk_score: 12, signals: {}, ...patch },
  request: { usd: 900, country: "GB" },
  event: { type: "payment", properties: { usd: 900, method: "card" } },
});

const queue = (patch: Partial<QueueDefinition> = {}): QueueDefinition => ({
  name: "Onboarding review",
  visibility: "workspace",
  sources: { actions: ["onboard_user"] },
  intake: [onboarding],
  correlation: { by: "subject", window_days: 30 },
  ...patch,
});

describe("evaluateRule", () => {
  it("matches on the outcome, the risk score, or one signal", () => {
    expect(evaluateRule(onboarding, decision({ outcome: "review" })).matched).toBe(true);
    expect(evaluateRule(onboarding, decision({ risk_score: 80 })).matched).toBe(true);
    expect(evaluateRule(onboarding, decision({ signals: { identity_mismatch: 0.93 } })).matched).toBe(true);
    expect(evaluateRule(onboarding, decision({ risk_score: 79, signals: { identity_mismatch: 0.4 } })).matched).toBe(
      false,
    );
  });

  it("opens work on an approved decision when one signal is high", () => {
    const result = evaluateRule(onboarding, decision({ outcome: "approve", signals: { identity_mismatch: 0.95 } }));
    expect(result.matched).toBe(true);
  });

  it("records every condition with what it read, also after the answer is known", () => {
    const result = evaluateRule(onboarding, decision({ outcome: "review", risk_score: 40 }));
    expect(result.conditions).toEqual([
      { field: "decision.outcome", op: "in", value: ["review", "step_up", "block"], read: "review", held: true },
      { field: "decision.risk_score", op: ">=", value: 80, read: 40, held: false },
      { field: "signal.identity_mismatch", op: ">=", value: 0.9, read: undefined, held: false },
    ]);
  });

  it("treats a missing field as false, never as an error", () => {
    const rule: IntakeRule = {
      id: "r",
      name: "r",
      conditions: { all: [{ field: "request.loan_amount", op: ">=", value: 1000 }] },
    };
    expect(evaluateRule(rule, decision()).matched).toBe(false);
  });

  it("compares numbers only with numbers", () => {
    const rule: IntakeRule = {
      id: "r",
      name: "r",
      conditions: { all: [{ field: "request.country", op: ">", value: 1 }] },
    };
    expect(evaluateRule(rule, decision()).matched).toBe(false);
  });

  it("runs all and any, two levels deep", () => {
    const rule: IntakeRule = {
      id: "lending",
      name: "Lending",
      conditions: {
        any: [
          { field: "decision.outcome", op: "=", value: "review" },
          {
            all: [
              { field: "signal.income_mismatch", op: ">=", value: 0.8 },
              { field: "request.usd", op: "between", value: [500, 1000] },
            ],
          },
        ],
      },
    };
    expect(evaluateRule(rule, decision({ signals: { income_mismatch: 0.85 } })).matched).toBe(true);
    expect(evaluateRule(rule, decision({ signals: { income_mismatch: 0.5 } })).matched).toBe(false);
  });

  it("reads event fields, and does not match a decision rule without a decision", () => {
    const eventRule: IntakeRule = {
      id: "e",
      name: "e",
      conditions: { all: [{ field: "event.type", op: "=", value: "payment" }] },
    };
    expect(needsDecision(eventRule)).toBe(false);
    expect(evaluateRule(eventRule, { event: { type: "payment", properties: {} } }).matched).toBe(true);
    expect(needsDecision(onboarding)).toBe(true);
    expect(evaluateRule(onboarding, { event: { type: "payment", properties: {} } }).matched).toBe(false);
  });
});

describe("ruleSentence", () => {
  it("says the rule as people read it", () => {
    expect(ruleSentence(onboarding.conditions)).toBe(
      "Outcome is review, step-up or block, or risk score is at least 80, or the identity mismatch signal is at least 0.90",
    );
  });
});

describe("highestPriority", () => {
  it("takes the highest, with normal for a rule that names none", () => {
    expect(highestPriority(["low", undefined])).toBe("normal");
    expect(highestPriority(["low", "urgent", "high"])).toBe("urgent");
    expect(highestPriority(["low"])).toBe("low");
    expect(highestPriority([])).toBe("normal");
  });
});

describe("correlation", () => {
  const input = {
    subject: { type: "user", id: "user_42" },
    entities: { user: "user_42", application: "app_7", device: "dev_9" },
    properties: { application_id: "A-1", usd: 900 },
    session: "sess_1",
    event_id: "evt_1",
  };

  it("makes one key for each kind of correlation", () => {
    expect(correlationKey({ by: "subject" }, input)).toBe("subject:user:user_42");
    expect(correlationKey({ by: "entity", type: "application" }, input)).toBe("entity:application:app_7");
    expect(correlationKey({ by: "session" }, input)).toBe("session:sess_1");
    expect(correlationKey({ by: "event" }, input)).toBe("event:evt_1");
    expect(correlationKey({ by: "request", property: "application_id" }, input)).toBe("request:application_id:A-1");
  });

  it("has no key when the trigger does not name it", () => {
    expect(correlationKey({ by: "entity", type: "loan" }, input)).toBeNull();
    expect(correlationKey({ by: "session" }, { ...input, session: undefined })).toBeNull();
    expect(correlationKey({ by: "request", property: "missing" }, input)).toBeNull();
  });

  it("targets the key's entity, else the subject", () => {
    expect(caseTarget({ by: "entity", type: "application" }, input)).toEqual({ type: "application", id: "app_7" });
    expect(caseTarget({ by: "session" }, input)).toEqual({ type: "user", id: "user_42" });
  });

  it("has a window only where a case can last", () => {
    expect(windowDays({ by: "subject" })).toBe(30);
    expect(windowDays({ by: "entity", type: "x", window_days: 90 })).toBe(90);
    expect(windowDays({ by: "event" })).toBeNull();
  });
});

describe("validateQueue", () => {
  it("accepts a complete definition", () => {
    expect(validateQueue(queue())).toEqual([]);
  });

  it("refuses the wrong scale on a score", () => {
    const wrong: IntakeRule = {
      ...onboarding,
      conditions: {
        any: [
          { field: "decision.risk_score", op: ">=", value: 180 },
          { field: "signal.identity_mismatch", op: ">=", value: 90 },
        ],
      },
    };
    expect(validateQueue(queue({ intake: [wrong] }))).toEqual([
      "intake[0].conditions.any[0].value: a risk score is a number from 0 to 100",
      "intake[0].conditions.any[1].value: a signal score is a probability from 0 to 1",
    ]);
  });

  it("refuses an outcome Kairos does not have", () => {
    const rule: IntakeRule = {
      ...onboarding,
      conditions: { all: [{ field: "decision.outcome", op: "in", value: ["refer"] }] },
    };
    expect(validateQueue(queue({ intake: [rule] }))[0]).toMatch(/"refer" is not an outcome/);
  });

  it("refuses an operator that does not fit the field", () => {
    const rule: IntakeRule = {
      ...onboarding,
      conditions: { all: [{ field: "decision.outcome", op: ">=", value: "review" }] },
    };
    expect(validateQueue(queue({ intake: [rule] }))[0]).toMatch(/compared with = or in/);
  });

  it("refuses a field that is not a field", () => {
    const rule: IntakeRule = { ...onboarding, conditions: { all: [{ field: "subject.age", op: ">", value: 1 }] } };
    expect(validateQueue(queue({ intake: [rule] }))[0]).toMatch(/"subject.age" is not a field/);
  });

  it("refuses groups more than two levels deep", () => {
    const rule: IntakeRule = {
      ...onboarding,
      conditions: { any: [{ all: [{ any: [{ field: "decision.outcome", op: "=", value: "review" }] }] }] },
    };
    expect(validateQueue(queue({ intake: [rule] }))[0]).toMatch(/two levels deep/);
  });

  it("refuses a window on a correlation that has none, and a key with no name", () => {
    expect(validateQueue(queue({ correlation: { by: "event", window_days: 3 } }))).toEqual([
      "correlation.window_days: a case by event has no window",
    ]);
    expect(validateQueue(queue({ correlation: { by: "entity" } }))).toEqual([
      "correlation.type: the entity type the key is",
    ]);
  });

  it("needs a source for a rule, and refuses two rules with one id", () => {
    expect(validateQueue(queue({ sources: {} }))[0]).toMatch(/a rule needs a source/);
    expect(validateQueue(queue({ intake: [onboarding, { ...onboarding, name: "Other" }] }))).toEqual([
      'intake[1].id: "held_or_risky" is used twice',
    ]);
  });

  it("accepts a queue with no rules, for cases from workflows only", () => {
    expect(validateQueue(queue({ sources: {}, intake: [] }))).toEqual([]);
  });

  it("checks the columns and the display", () => {
    expect(validateQueue(queue({ columns: ["target", "request.usd", "subject.country"] }))).toEqual([]);
    expect(validateQueue(queue({ columns: ["nope"] }))[0]).toMatch(/"nope" is not a column/);
    expect(validateQueue(queue({ display: { icon: "shield", color: "purple" } }))).toEqual([]);
    expect(validateQueue(queue({ display: { icon: "rocket" as never } }))[0]).toMatch(/display.icon/);
  });
});

describe("due times and reopening", () => {
  it("gives a due time for a priority with hours, and none for one without", () => {
    const start = new Date("2026-10-27T10:00:00Z");
    expect(dueAt({ high: 4 }, "high", start)?.toISOString()).toBe("2026-10-27T14:00:00.000Z");
    expect(dueAt({ high: 4 }, "low", start)).toBeNull();
    expect(dueAt(undefined, "high", start)).toBeNull();
  });

  it("checks the due hours and the reopen days", () => {
    expect(validateQueue(queue({ due_hours: { urgent: 1, high: 24 } }))).toEqual([]);
    expect(validateQueue(queue({ due_hours: { soon: 1 } as never }))[0]).toMatch(/due_hours.soon: not a priority/);
    expect(validateQueue(queue({ due_hours: { high: 0 } }))[0]).toMatch(/due_hours.high: hours/);
    expect(validateQueue(queue({ correlation: { by: "subject", reopen_days: 7 } }))).toEqual([]);
    expect(validateQueue(queue({ correlation: { by: "subject", reopen_days: 0 } }))[0]).toMatch(/reopen_days/);
  });
});
