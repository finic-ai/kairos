import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signEdge, verifyEdge } from "../src/routes.js";
import type { Decision } from "../src/types.js";

const hash = (value: string) => createHmac("sha256", "hash-key").update(value).digest("hex");
const other = (value: string) => createHmac("sha256", "other-key").update(value).digest("hex");

describe("the edge header", () => {
  const decision: Decision = {
    decision: "step_up",
    riskScore: 72,
    probability: 0.72,
    reasons: ["A new device signs in from a country the user has never used — café"],
    rules: ["new_device"],
    decisionId: "dec_1",
    eventId: "evt_1",
    fallback: false,
  };
  const request = { method: "post", path: "/transfers" };

  it("gives the short fields of the decision for the same request", async () => {
    const header = await signEdge(hash, { ...request, decision }, 1_000);
    expect(await verifyEdge(hash, header, { method: "POST", path: "/transfers" }, 2_000)).toEqual({
      decision: { ...decision, reasons: [], rules: [] },
    });
    expect(await verifyEdge(hash, await signEdge(hash, request, 1_000), request, 1_000)).toEqual({});
  });

  it("refuses another key, request, a changed payload, and an old header", async () => {
    const header = await signEdge(hash, { ...request, decision }, 1_000);
    const [payload, signature] = header.split(".");
    expect(await verifyEdge(other, header, request, 1_000)).toBeUndefined();
    expect(await verifyEdge(hash, header, { method: "PUT", path: "/transfers" }, 1_000)).toBeUndefined();
    expect(await verifyEdge(hash, header, { method: "POST", path: "/payees" }, 1_000)).toBeUndefined();
    expect(await verifyEdge(hash, `${payload}x.${signature}`, request, 1_000)).toBeUndefined();
    expect(await verifyEdge(hash, `${header}.more`, request, 1_000)).toBeUndefined();
    expect(await verifyEdge(hash, header, request, 1_000 + 5 * 60_000 + 1)).toBeUndefined();
    expect(await verifyEdge(hash, undefined, request, 1_000)).toBeUndefined();
  });
});
