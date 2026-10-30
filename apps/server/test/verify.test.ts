import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { secretHeaders, verificationProblem, verify, type Verification } from "../src/modules/webhooks/libs";

const raw = (s: string) => Buffer.from(s);
const at = (seconds: number) => new Date(seconds * 1000);

describe("verify", () => {
  it("checks Standard Webhooks with the published example", () => {
    // From https://github.com/standard-webhooks/standard-webhooks (spec, "Verifying signatures").
    const body = raw('{"test": 2432232314}');
    const headers = {
      "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
      "webhook-timestamp": "1614265330",
      "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    };
    const v: Verification = { scheme: "standard" };
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    expect(verify(v, body, headers, [secret], at(1614265330))).toBeNull();
    // A list of signatures, one of them right; and the svix- names.
    expect(
      verify(
        v,
        body,
        { ...headers, "webhook-signature": `v1,AAAA v1a,xyz ${headers["webhook-signature"]}` },
        [secret],
        at(1614265330),
      ),
    ).toBeNull();
    expect(
      verify(
        v,
        body,
        {
          "svix-id": headers["webhook-id"],
          "svix-timestamp": headers["webhook-timestamp"],
          "svix-signature": headers["webhook-signature"],
        },
        [secret],
        at(1614265330),
      ),
    ).toBeNull();
    expect(verify(v, raw('{"test": 2432232315}'), headers, [secret], at(1614265330))).toBe(
      "the signature does not match",
    );
    expect(verify(v, body, headers, [secret], at(1614265330 + 301))).toContain("more than 5 minutes");
    expect(verify(v, body, { "webhook-id": "x" }, [secret], at(1614265330))).toContain("no webhook-id");
    expect(secretHeaders(v)).toContain("webhook-signature");
  });

  it("checks an HMAC in a list, as Fingerprint sends it", () => {
    // From Fingerprint's webhook guide: payload "payload", secret "secret".
    const v: Verification = { scheme: "hmac", header: "FPJS-Event-Signature", prefix: "v1=" };
    const good = "v1=b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4";
    expect(verify(v, raw("payload"), { "fpjs-event-signature": good }, ["secret"], new Date())).toBeNull();
    expect(verify(v, raw("payload"), { "fpjs-event-signature": `v1=00,${good}` }, ["secret"], new Date())).toBeNull();
    expect(verify(v, raw("payload"), { "fpjs-event-signature": good }, ["wrongsecret"], new Date())).toBe(
      "the signature does not match",
    );
  });

  it("checks a time in its own header, as Zendesk sends it", () => {
    const v: Verification = {
      scheme: "timestamped",
      header: "X-Zendesk-Webhook-Signature",
      timestampHeader: "X-Zendesk-Webhook-Signature-Timestamp",
      join: "",
      encoding: "base64",
    };
    const time = "2026-10-20T10:00:00Z";
    const body = '{"type":"zen:event-type:ticket.created"}';
    const signature = createHmac("sha256", "zd-secret").update(`${time}${body}`).digest("base64");
    const headers = { "x-zendesk-webhook-signature": signature, "x-zendesk-webhook-signature-timestamp": time };
    const now = new Date(Date.parse(time) + 60_000);
    expect(verify(v, raw(body), headers, ["zd-secret"], now)).toBeNull();
    expect(verify(v, raw(body), headers, ["other"], now)).toBe("the signature does not match");
    expect(verify(v, raw(body), headers, ["zd-secret"], new Date(Date.parse(time) + 400_000))).toContain(
      "more than 5 minutes",
    );
    expect(verify(v, raw(body), { "x-zendesk-webhook-signature": signature }, ["zd-secret"], now)).toBe(
      "no X-Zendesk-Webhook-Signature-Timestamp header",
    );
  });

  it("checks t=…,v1=… in one header, as Persona and Stripe send it", () => {
    const body = '{"data":{"type":"event"}}';
    const t = 1792065600;
    const sig = (secret: string) => createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    const persona: Verification = { scheme: "timestamped", header: "Persona-Signature" };
    // During a rotation Persona sends two pairs, separated by a space.
    expect(
      verify(
        persona,
        raw(body),
        { "persona-signature": `t=${t},v1=${sig("old")} t=${t},v1=${sig("new")}` },
        ["new"],
        at(t),
      ),
    ).toBeNull();
    expect(verify(persona, raw(body), { "persona-signature": `t=${t}` }, ["new"], at(t))).toBe(
      "Persona-Signature has no t= or v1=",
    );
    // "stripe" is the same check with Stripe's names.
    expect(
      verify(
        { scheme: "stripe" },
        raw(body),
        { "stripe-signature": `t=${t},v1=${sig("whsec_x")}` },
        ["whsec_x"],
        at(t),
      ),
    ).toBeNull();
    expect(
      verify(
        { scheme: "stripe" },
        raw(body),
        { "stripe-signature": `t=${t},v1=${sig("whsec_x")}` },
        ["whsec_x"],
        at(t + 301),
      ),
    ).toContain("more than 5 minutes");
  });

  it("refuses a setting that is not valid", () => {
    expect(verificationProblem({ scheme: "standard" })).toBeNull();
    expect(
      verificationProblem({
        scheme: "timestamped",
        header: "X-Sig",
        timestampHeader: "X-Time",
        join: "",
        encoding: "base64",
        tolerance: 600,
      }),
    ).toBeNull();
    expect(verificationProblem({ scheme: "timestamped" })).toContain("verification.header");
    expect(verificationProblem({ scheme: "timestamped", header: "X-Sig", timestampHeader: "bad header" })).toContain(
      "timestampHeader",
    );
    expect(verificationProblem({ scheme: "timestamped", header: "X-Sig", signatureKey: "v1=" })).toContain(
      "signatureKey",
    );
    expect(verificationProblem({ scheme: "timestamped", header: "X-Sig", join: "-----" })).toContain("join");
    expect(verificationProblem({ scheme: "standard", tolerance: 0 })).toContain("tolerance");
  });
});
