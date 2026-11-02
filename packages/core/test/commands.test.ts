import { describe, expect, it } from "vitest";
import { commandAnswer, commandState, readCommandInputs, validateEntity, type EntityCommand } from "../src";

const block: EntityCommand = {
  name: "Block user",
  key: "block_user",
  label: "Block user",
  color: "red",
  icon: "shield",
  inputs: [
    { name: "reason", label: "Reason", type: "text", required: true },
    { name: "notify", label: "Email the user", type: "boolean" },
  ],
};

describe("commands", () => {
  it("accepts a command on an entity type", () => {
    expect(validateEntity({ type: "user", commands: [block] })).toEqual([]);
    expect(
      validateEntity({
        type: "user",
        commands: [{ ...block, description: "Stops the user from signing in" }],
      }),
    ).toEqual([]);
  });

  it("refuses a blank name, a missing key, or a long description", () => {
    expect(validateEntity({ type: "user", commands: [{ ...block, name: "  " }] })).toHaveLength(1);
    expect(validateEntity({ type: "user", commands: [{ ...block, key: "" }] })).toHaveLength(1);
    expect(validateEntity({ type: "user", commands: [{ ...block, description: "x".repeat(501) }] })).toHaveLength(1);
  });

  it("refuses a second command with the same key", () => {
    expect(validateEntity({ type: "user", commands: [block, { ...block, name: "Block again" }] })).toHaveLength(1);
  });

  it("reads the inputs in the order of the definition", () => {
    const bad = readCommandInputs(block, { notify: false, reason: "Account takeover", extra: 1 });
    expect(bad.problems).toEqual(["inputs.extra is not a field of this command"]);
    expect(Object.keys(readCommandInputs(block, { notify: true, reason: "Account takeover" }).inputs)).toEqual([
      "reason",
      "notify",
    ]);
  });

  it("reads the webhook answer", () => {
    expect(commandAnswer(200)).toBe("acted");
    expect(commandAnswer(202)).toBe("received");
    expect(commandAnswer(204)).toBe("received");
    expect(commandAnswer(500)).toBe("not_delivered");
    expect(commandAnswer(undefined)).toBe("not_delivered");
    expect(commandState([{ status: "delivered", responseStatus: 200 }])).toBe("acted");
    expect(commandState([{ status: "delivered", responseStatus: 202 }])).toBe("received");
    expect(commandState([{ status: "pending", responseStatus: null }])).toBe("sending");
    expect(commandState([])).toBe("not_sent");
    expect(commandState([{ status: "failed", responseStatus: 500 }])).toBe("not_delivered");
  });
});
