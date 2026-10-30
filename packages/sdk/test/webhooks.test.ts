import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KairosWebhookError, verifyWebhook } from "../src/index.js";

// The test vector of the Standard Webhooks specification.
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const OTHER = "whsec_" + Buffer.from("another secret of thirty-two bytes!").toString("base64");
const NOW = new Date(1614265330 * 1000);

const sign = (secret: string, id: string, ts: number, body: string) =>
  `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${ts}.${body}`)
    .digest("base64")}`;

const body = JSON.stringify({
  id: "msg_1",
  type: "decision.created",
  version: 1,
  workspace_id: "ws_1",
  created_at: "2021-02-25T15:02:10Z",
  data: { decision: "block" },
});
const headers = (signature = sign(SECRET, "msg_1", 1614265330, body), ts = "1614265330") => ({
  "webhook-id": "msg_1",
  "webhook-timestamp": ts,
  "webhook-signature": signature,
});

describe("verifyWebhook", () => {
  it("matches the Standard Webhooks reference signature", async () => {
    expect(sign(SECRET, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}')).toBe(
      "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    );
    const reference = {
      "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
      "webhook-timestamp": "1614265330",
      "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    };
    expect(await verifyWebhook('{"test": 2432232314}', reference, SECRET, { now: NOW })).toEqual({ test: 2432232314 });
  });

  it("returns the message, from a string, bytes, Headers or a Node header object", async () => {
    expect((await verifyWebhook(body, headers(), SECRET, { now: NOW })).data).toEqual({ decision: "block" });
    expect(
      (await verifyWebhook(new TextEncoder().encode(body), new Headers(headers()), SECRET, { now: NOW })).type,
    ).toBe("decision.created");
    const upper = Object.fromEntries(Object.entries(headers()).map(([k, v]) => [k.toUpperCase(), [v]]));
    expect((await verifyWebhook(body, upper, SECRET, { now: NOW })).id).toBe("msg_1");
  });

  it("accepts any of two signatures and any of two secrets, for a rotation", async () => {
    const both = `${sign(OTHER, "msg_1", 1614265330, body)} ${sign(SECRET, "msg_1", 1614265330, body)}`;
    expect((await verifyWebhook(body, headers(both), SECRET, { now: NOW })).id).toBe("msg_1");
    expect((await verifyWebhook(body, headers(), [OTHER, SECRET], { now: NOW })).id).toBe("msg_1");
  });

  it("refuses a changed body, a wrong secret, an old timestamp and missing headers", async () => {
    const refused = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(KairosWebhookError);
    await refused(verifyWebhook(body.replace("block", "approve"), headers(), SECRET, { now: NOW }));
    await refused(verifyWebhook(body, headers(), OTHER, { now: NOW }));
    await refused(verifyWebhook(body, headers(), SECRET, { now: new Date(NOW.getTime() + 301_000) }));
    await refused(verifyWebhook(body, { "webhook-id": "msg_1" }, SECRET, { now: NOW }));
    await refused(verifyWebhook(body, headers("v1,not base64!"), SECRET, { now: NOW }));
    // A signature of the right body at another time does not move to a new timestamp.
    await refused(verifyWebhook(body, headers(undefined, "1614265331"), SECRET, { now: NOW }));
  });
});
