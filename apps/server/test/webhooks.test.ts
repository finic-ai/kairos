import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Webhooks } from "../src/context";
import { decisions, labels, memberships, webhookDeliveries, webhooks } from "../src/db/schema";
import { secretBox, type SecretBox } from "../src/platform/secrets";
import { tenancyRepository, createRepositories, environmentsRepository } from "../src/repositories";
import { JobsService } from "../src/services/job.service";
import { enqueueOutbound } from "../src/modules/webhooks/repo";
import type { OutboundConfig } from "../src/modules/webhooks/types";
import {
  guardedLookup,
  isPrivateAddress,
  urlProblem,
  signature,
  createWebhookWorker,
  type WebhookWorker,
} from "../src/modules/webhooks/libs";
import { EnvironmentsService } from "../src/services/environment.service";
import { WebhookDeliveriesService } from "../src/services/webhook_delivery.service";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const START = new Date("2026-10-14T09:00:00Z");

interface Received {
  headers: IncomingMessage["headers"];
  body: string;
}
let received: Received[] = [];
/** The answers the receiver gives, in order; the last one repeats. */
let answers: number[] = [200];
let receiver: Server;
let receiverUrl: string;

beforeAll(async () => {
  receiver = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ headers: request.headers, body });
      const status = answers.length > 1 ? answers.shift()! : answers[0]!;
      response.writeHead(status, { "content-type": "text/plain" }).end(status === 200 ? "ok" : "no");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks`;
});
afterAll(() => new Promise<void>((resolve) => receiver.close(() => resolve())));

let clock: Date;
let app: ReturnType<typeof createApp>;
let box: SecretBox;
let worker: WebhookWorker;
let hooks: Webhooks;
let probability: number;
let cookie: string;
let workspace: string;

const jobs = new JobsService(database.db);

let wakes = 0;

/** `wake`: whether the app's worker sends at once after a decision. Off by default, so that each test drains when it chooses. */
function build(
  options: {
    allowPrivate?: boolean;
    secretBox?: boolean;
    worker?: boolean;
    wake?: boolean;
    cronSecret?: string;
    warning?: string;
  } = {},
) {
  box = secretBox(randomBytes(32));
  worker = createWebhookWorker({
    db: database.db,
    jobs,
    secretBox: box,
    now: () => clock,
    allowPrivate: options.allowPrivate ?? true,
    random: () => 0.5,
    log: () => {},
  });
  const appWorker = options.wake ? worker : { ...worker, wake: () => void wakes++ };
  hooks = {
    db: database.db,
    secretBox: options.secretBox === false ? undefined : box,
    worker: options.worker === false ? undefined : appWorker,
    allowPrivate: options.allowPrivate ?? true,
    cronSecret: options.cronSecret,
    warning: options.warning,
  };
  app = createApp({
    repos: createRepositories(database.db),
    environments: environmentsRepository(database.db),
    accounts: tenancyRepository(database.db),
    decider: async () => ({
      id: "d",
      model: "grayson-1",
      answers: { hold: { type: "noul", value: probability >= 0.5, probability } },
      usage: { input_tokens: 1 },
    }),
    now: () => clock,
    webhooks: hooks,
  });
}

const call = async (method: string, path: string, body?: unknown, as = cookie) => {
  const response = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: as,
      ...(path.startsWith("/v1") ? { "X-Kairos-Workspace": workspace } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};

async function signup(email: string) {
  const response = await app.request("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse", name: "Test" }),
  });
  const data = (await response.json()) as any;
  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]!,
    workspace: data.workspaces[0].id as string,
    user: data.user.id as string,
  };
}

beforeEach(async () => {
  await database.reset();
  clock = START;
  received = [];
  answers = [200];
  wakes = 0;
  probability = 0.04;
  build();
  ({ cookie, workspace } = await signup("owner@example.com"));
  expect(
    (await call("PUT", "/v1/actions/payout", { subject: "merchant", hold: "Should this payout be held?" })).status,
  ).toBe(200);
});

const hooksPath = () => `/app/workspaces/${workspace}/webhooks`;
const createHook = (extra: Record<string, unknown> = {}) =>
  call("POST", hooksPath(), {
    direction: "out",
    name: "Fraud queue",
    url: receiverUrl,
    events: ["decision.created"],
    ...extra,
  });
const decide = (extra: Record<string, unknown> = {}) =>
  call("POST", "/v1/decide", {
    action: "payout",
    entities: { merchant: "m1", bank: "b7" },
    properties: { usd: 4200 },
    ...extra,
  });
const deliveriesOf = async (id: string) =>
  (await call("GET", `${hooksPath()}/${id}/deliveries`)).body.deliveries as any[];
const later = (ms: number) => (clock = new Date(clock.getTime() + ms));
/** A secret API key of the workspace, made in the console as a person would. */
const secretKey = async () =>
  (await call("POST", `/app/workspaces/${workspace}/keys`, { name: "server", kind: "secret" })).body.secret as string;

/** Check a delivery as a receiver would, with the Standard Webhooks scheme. */
function verified(r: Received, secret: string): boolean {
  const id = r.headers["webhook-id"] as string;
  const timestamp = Number(r.headers["webhook-timestamp"]);
  const expected = signature(secret, id, timestamp, r.body);
  return String(r.headers["webhook-signature"]).split(" ").includes(expected);
}

describe("signing and addresses", () => {
  it("signs as the Standard Webhooks reference does", () => {
    expect(
      signature(
        "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
        "msg_p5jXN8AQM9LWM0D4loKWxJek",
        1614265330,
        '{"test": 2432232314}',
      ),
    ).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("refuses private, local and reserved addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::a9fe:a9fe",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
      expect(isPrivateAddress(address), address).toBe(false);
  });

  it("checks a URL when it is saved", () => {
    expect(urlProblem("https://hooks.example.com/kairos", false)).toBeUndefined();
    expect(urlProblem("http://hooks.example.com/kairos", false)).toBe("must start with https://");
    expect(urlProblem("https://user:pw@hooks.example.com", false)).toContain("user name");
    for (const url of [
      "https://127.0.0.1/x",
      "https://localhost/x",
      "https://[::1]/x",
      "https://intranet/x",
      "https://169.254.169.254/latest",
    ]) {
      expect(urlProblem(url, false), url).toContain("private or local");
    }
    expect(urlProblem("http://127.0.0.1:9000/x", true)).toBeUndefined();
    expect(urlProblem("not a url", true)).toBe("is not a URL");
  });

  it("refuses a host name that resolves to a private address, at the moment of the connection", async () => {
    const resolve = (allowPrivate: boolean) =>
      new Promise<{ error?: Error; address?: string }>((done) =>
        guardedLookup(allowPrivate)("localhost", {}, (error: Error | null, address?: string) =>
          done({ error: error ?? undefined, address }),
        ),
      );
    expect((await resolve(false)).error?.message).toMatch(/localhost resolves to .*private or local/);
    expect((await resolve(true)).address).toMatch(/^(127\.0\.0\.1|::1)$/);
  });

  it("encrypts a secret so that only the same key opens it", () => {
    const sealed = box.encrypt("whsec_abc", "whsec_a…", START.toISOString());
    expect(sealed.ciphertext).not.toContain("abc");
    expect(box.decrypt(sealed)).toBe("whsec_abc");
    expect(() => secretBox(randomBytes(32)).decrypt(sealed)).toThrow();
  });
});

describe("endpoints", () => {
  it("returns the secret once, then only a hint", async () => {
    const created = await createHook();
    expect(created.status).toBe(200);
    expect(created.body.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(created.body.webhook).toMatchObject({
      direction: "out",
      name: "Fraud queue",
      url: receiverUrl,
      events: ["decision.created"],
      include_properties: true,
      enabled: true,
    });
    const shown = await call("GET", `${hooksPath()}/${created.body.webhook.id}`);
    expect(JSON.stringify(shown.body)).not.toContain(created.body.secret);
    expect(shown.body.secret_hints).toHaveLength(1);
    const listed = await call("GET", `${hooksPath()}?direction=out`);
    expect(listed.body.webhooks.map((w: any) => w.id)).toEqual([created.body.webhook.id]);
  });

  it("refuses a bad URL, an unknown event type and an incomplete source", async () => {
    build({ allowPrivate: false });
    expect((await createHook({ url: "https://127.0.0.1/x" })).body.error.message).toContain("private or local");
    expect((await createHook({ events: ["decision.deleted"] })).status).toBe(400);
    expect((await createHook({ events: [] })).status).toBe(400);
    // An incoming source needs a verification and a mapping (see inbound.test.ts).
    expect((await call("POST", hooksPath(), { direction: "in", name: "Stripe" })).body.error.message).toContain(
      "verification",
    );
  });

  it("needs the admin role, and hides other workspaces", async () => {
    const other = await signup("other@example.com");
    expect((await call("GET", hooksPath(), undefined, other.cookie)).status).toBe(404);
    await database.db.insert(memberships).values({
      id: `mem_${other.user}`,
      workspaceId: workspace,
      userId: other.user,
      role: "member",
      created: START,
      updated: START,
    });
    expect((await call("GET", hooksPath(), undefined, other.cookie)).status).toBe(403);
  });

  it("says what is missing when the server cannot send", async () => {
    build({ secretBox: false });
    expect((await createHook()).body.error.message).toContain("KAIROS_ENCRYPTION_KEY");
    build({ worker: false });
    expect((await createHook()).body.error.type).toBe("webhooks_unavailable");
    expect((await call("GET", hooksPath())).body.unavailable).toContain("worker");
  });
});

describe("decision.created", () => {
  it("delivers a signed decision that the receiver can check", async () => {
    const { webhook, secret } = (await createHook()).body;
    const decision = (await decide({ session: "s_1" })).body;
    expect(await worker.drain()).toBe(1);

    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(verified(r, secret)).toBe(true);
    expect(r.headers["webhook-timestamp"]).toBe(String(START.getTime() / 1000));
    const message = JSON.parse(r.body);
    expect(message).toMatchObject({ type: "decision.created", version: 1, workspace_id: workspace });
    expect(message.id).toBe(r.headers["webhook-id"]);
    expect(message.data).toMatchObject({
      decision_id: decision.decision_id,
      revision: 1,
      action: "payout@1",
      subject: { type: "merchant", id: "m1" },
      entities: { merchant: "m1", bank: "b7" },
      session: "s_1",
      properties: { usd: 4200 },
      decision: "approve",
      risk_score: 4,
      final_outcome: "approve",
      resolution: null,
      automatic: false,
    });
    expect(message.data).not.toHaveProperty("context");

    const about = (
      await call("GET", `/app/workspaces/${workspace}/webhook-deliveries?subject=decision:${decision.decision_id}`)
    ).body.deliveries;
    expect(about).toMatchObject([{ webhook_id: webhook.id, webhook_name: "Fraud queue", status: "delivered" }]);
    const [logged] = await deliveriesOf(webhook.id);
    expect(logged).toMatchObject({
      status: "delivered",
      attempts: 1,
      response_status: 200,
      type: "decision.created",
      subject_ref: `decision:${decision.decision_id}`,
      external_id: message.id,
    });
    const detail = (await call("GET", `${hooksPath()}/${webhook.id}/deliveries/${logged.id}`)).body;
    expect(detail.payload).toEqual(message);
    // The log keeps the headers, without the signature itself.
    expect(detail.headers["webhook-signature"]).toBe("v1,…");
    expect(detail.response_body).toBe("ok");
  });

  it("is sent at once after the decision, with no wait for the next tick", async () => {
    build({ wake: true });
    await createHook();
    await decide();
    for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(1);
    await worker.drain();
    expect(received).toHaveLength(1);
  });

  it("tells the worker only when something was queued", async () => {
    await decide();
    expect(wakes).toBe(0);
    await createHook();
    await decide();
    expect(wakes).toBe(1);
  });

  it("sends nothing for a decision as of a past moment", async () => {
    await createHook();
    await decide({ ts: "2026-09-01T00:00:00Z" });
    expect(await worker.drain()).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("delivers a decision started by an event", async () => {
    await call("PUT", "/v1/actions/payout", {
      subject: "merchant",
      hold: "Should this payout be held?",
      trigger: "payout_requested",
    });
    await createHook();
    const response = await call("POST", "/v1/events/decide", {
      id: "evt_9",
      type: "payout_requested",
      ts: "2026-10-14T08:59:00Z",
      entities: { merchant: "m1" },
      properties: {},
    });
    expect(response.status).toBe(200);
    await worker.drain();
    expect(JSON.parse(received[0]!.body).data).toMatchObject({
      event_id: "evt_9",
      decision_id: response.body.decision_id,
    });
  });

  it("sends only what an endpoint's filters let through", async () => {
    const blocks = (await createHook({ name: "Blocks", filter: { outcomes: ["block"] } })).body.webhook;
    const risky = (await createHook({ name: "Risky", filter: { min_risk_score: 50 } })).body.webhook;
    const other = (await createHook({ name: "Other action", filter: { actions: ["withdrawal"] } })).body.webhook;
    const quiet = (await createHook({ name: "No properties", include_properties: false })).body.webhook;
    await decide();
    probability = 0.95;
    await decide();
    await worker.drain();
    expect((await deliveriesOf(blocks.id)).length).toBe(1);
    expect((await deliveriesOf(risky.id)).length).toBe(1);
    expect((await deliveriesOf(other.id)).length).toBe(0);
    expect((await deliveriesOf(quiet.id)).length).toBe(2);
    const toQuiet = received
      .filter((r) => (r.headers["webhook-id"] as string) && JSON.parse(r.body).data.risk_score !== undefined)
      .map((r) => JSON.parse(r.body));
    expect(toQuiet.some((m) => !("properties" in m.data))).toBe(true);
    // One event has one message id, at every endpoint.
    const ids = new Set(received.map((r) => r.headers["webhook-id"]));
    expect(ids.size).toBe(2);
  });

  it("sends nothing to a disabled endpoint, and nothing for an event that is not wanted", async () => {
    const { webhook } = (await createHook()).body;
    await call("PATCH", `${hooksPath()}/${webhook.id}`, { enabled: false });
    await decide();
    await worker.drain();
    expect(received).toHaveLength(0);
    expect(await deliveriesOf(webhook.id)).toHaveLength(0);
  });

  it("writes deliveries only with the thing they are about", async () => {
    await createHook();
    const event = {
      type: "decision.created" as const,
      data: {},
      match: { action: "payout@1", outcome: "approve", riskScore: 1 },
    };
    await expect(
      database.db.transaction(async (tx) => {
        expect(
          await enqueueOutbound(
            tx,
            workspace,
            (await new EnvironmentsService(database.db, { workspaceId: workspace }).findByIdOrProduction())!.id,
            event,
            clock,
          ),
        ).toBe(1);
        throw new Error("the decision was not saved");
      }),
    ).rejects.toThrow();
    expect((await database.db.select().from(webhookDeliveries)).length).toBe(0);
  });
});

describe("a write and its deliveries are one transaction", () => {
  /** An endpoint whose config has no event types: writing a delivery for it throws, after the thing itself was written. */
  const brokenEndpoint = async () => {
    const environmentId = (await new EnvironmentsService(database.db, {
      workspaceId: workspace,
    }).findByIdOrProduction())!.id;
    await database.db.insert(webhooks).values({
      id: "wh_broken",
      workspaceId: workspace,
      environmentId,
      direction: "out",
      name: "Broken",
      url: receiverUrl,
      secrets: [],
      // No event types: not a config the API accepts, which is the point.
      config: {} as OutboundConfig,
      created: clock,
      updated: clock,
    });
  };

  it("saves no decision when its deliveries cannot be written", async () => {
    await brokenEndpoint();
    expect((await decide()).status).toBe(500);
    expect(await database.db.select().from(decisions)).toHaveLength(0);
  });

  it("keeps the old resolution when the deliveries of the new one cannot be written", async () => {
    const decided = (await decide()).body;
    await brokenEndpoint();
    expect((await call("POST", `/v1/decisions/${decided.decision_id}/resolution`, { outcome: "block" })).status).toBe(
      500,
    );
    const [row] = await database.db.select().from(decisions);
    expect(row).toMatchObject({ revision: 1, resolution: null });
  });

  it("saves no label when its deliveries cannot be written", async () => {
    await brokenEndpoint();
    const sent = await call("POST", "/v1/labels", {
      batch: [{ entity: { type: "merchant", id: "m1" }, label: "fraud_confirmed", ts: clock.toISOString() }],
    });
    expect(sent.status).toBe(500);
    expect(await database.db.select().from(labels)).toHaveLength(0);
  });
});

describe("retries", () => {
  it("tries again on a schedule, and succeeds when the receiver is back", async () => {
    const { webhook } = (await createHook()).body;
    answers = [500, 503, 200];
    await decide();
    await worker.drain();
    let [d] = await deliveriesOf(webhook.id);
    expect(d).toMatchObject({ status: "pending", attempts: 1, response_status: 500, problem: "answered 500" });
    expect(new Date(d.next_attempt).getTime() - clock.getTime()).toBe(5_000);
    expect((await call("GET", `${hooksPath()}/${webhook.id}`)).body.failing_since).toBe(START.toISOString());

    expect(await worker.drain()).toBe(0);
    later(5_000);
    await worker.drain();
    [d] = await deliveriesOf(webhook.id);
    expect(d).toMatchObject({ status: "pending", attempts: 2 });
    expect(new Date(d.next_attempt).getTime() - clock.getTime()).toBe(5 * 60_000);

    later(5 * 60_000);
    await worker.drain();
    [d] = await deliveriesOf(webhook.id);
    expect(d).toMatchObject({ status: "delivered", attempts: 3, problem: null });
    expect((await call("GET", `${hooksPath()}/${webhook.id}`)).body.failing_since).toBeNull();
    // The same message, on each attempt.
    expect(new Set(received.map((r) => r.headers["webhook-id"])).size).toBe(1);
  });

  it("gives up after the last attempt", async () => {
    const { webhook } = (await createHook()).body;
    answers = [500];
    await decide();
    for (let i = 0; i < 8; i++) {
      await worker.drain();
      later(11 * 3_600_000);
    }
    const [d] = await deliveriesOf(webhook.id);
    expect(d).toMatchObject({ status: "failed", attempts: 8 });
    expect(d.next_attempt).toBeNull();
  });

  it("disables an endpoint that answers 410, or that fails for 5 days", async () => {
    const gone = (await createHook()).body.webhook;
    answers = [410];
    await decide();
    await worker.drain();
    const shown = (await call("GET", `${hooksPath()}/${gone.id}`)).body;
    expect(shown).toMatchObject({ enabled: false, disabled_reason: "The endpoint answered 410 Gone." });
    expect((await deliveriesOf(gone.id))[0].status).toBe("failed");

    await call("DELETE", `${hooksPath()}/${gone.id}`);
    const failing = (await createHook()).body.webhook;
    answers = [500];
    await decide();
    await worker.drain();
    later(5 * 86_400_000);
    await decide();
    await worker.drain();
    expect((await call("GET", `${hooksPath()}/${failing.id}`)).body).toMatchObject({
      enabled: false,
      disabled_reason: "Every delivery failed for 5 days.",
    });
    // Enabled again, it starts over and its waiting deliveries go.
    answers = [200];
    await call("PATCH", `${hooksPath()}/${failing.id}`, { enabled: true });
    later(86_400_000);
    await worker.drain();
    expect((await call("GET", `${hooksPath()}/${failing.id}`)).body).toMatchObject({
      enabled: true,
      disabled_reason: null,
      failing_since: null,
    });
  });

  it("holds waiting deliveries while their endpoint is disabled, and sends them when it is enabled", async () => {
    const { webhook } = (await createHook()).body;
    await decide();
    await call("PATCH", `${hooksPath()}/${webhook.id}`, { enabled: false });
    await worker.drain();
    expect(received).toHaveLength(0);
    expect(await jobs.findByKey("webhook.deliver", (await deliveriesOf(webhook.id))[0].id)).toMatchObject({
      status: "paused",
      attempts: 0,
    });
    later(3_600_000);
    await call("PATCH", `${hooksPath()}/${webhook.id}`, { enabled: true });
    await worker.drain();
    expect(received).toHaveLength(1);
    expect((await deliveriesOf(webhook.id))[0]).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("never sends one attempt twice from two workers", async () => {
    await createHook();
    for (let i = 0; i < 12; i++) await decide();
    const second = createWebhookWorker({
      db: database.db,
      jobs,
      secretBox: box,
      now: () => clock,
      allowPrivate: true,
      log: () => {},
    });
    const [a, b] = await Promise.all([worker.drain(), second.drain()]);
    expect(a + b).toBe(12);
    expect(received).toHaveLength(12);
  });

  it("refuses a private address at send time unless allowed", async () => {
    const { webhook } = (await createHook()).body;
    const strict = createWebhookWorker({
      db: database.db,
      jobs,
      secretBox: box,
      now: () => clock,
      allowPrivate: false,
      log: () => {},
    });
    await decide();
    await strict.drain();
    expect((await deliveriesOf(webhook.id))[0].problem).toContain("must start with https://");
    expect(received).toHaveLength(0);
  });

  it("records a secret that cannot be read, and tries again later", async () => {
    const { webhook } = (await createHook()).body;
    const otherKey = createWebhookWorker({
      db: database.db,
      jobs,
      secretBox: secretBox(randomBytes(32)),
      now: () => clock,
      allowPrivate: true,
      log: () => {},
    });
    await decide();
    await otherKey.drain();
    expect((await deliveriesOf(webhook.id))[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      problem: expect.stringContaining("KAIROS_ENCRYPTION_KEY"),
    });
    expect(received).toHaveLength(0);
  });

  it("deletes old deliveries", async () => {
    const { webhook } = (await createHook()).body;
    await decide();
    await worker.drain();
    expect(await WebhookDeliveriesService.cleanup(database.db, new Date(clock.getTime() + 29 * 86_400_000), 30)).toBe(
      0,
    );
    expect(await WebhookDeliveriesService.cleanup(database.db, new Date(clock.getTime() + 31 * 86_400_000), 30)).toBe(
      1,
    );
    expect(await deliveriesOf(webhook.id)).toHaveLength(0);
  });
});

describe("test, resend and rotation", () => {
  it("sends a test message now, and does not retry it", async () => {
    const { webhook, secret } = (await createHook()).body;
    const ok = (await call("POST", `${hooksPath()}/${webhook.id}/test`)).body;
    expect(ok).toMatchObject({ delivered: true, status: 200, problem: null });
    expect(JSON.parse(received[0]!.body).type).toBe("webhook.test");
    expect(verified(received[0]!, secret)).toBe(true);

    answers = [500];
    const failed = (await call("POST", `${hooksPath()}/${webhook.id}/test`)).body;
    expect(failed).toMatchObject({ delivered: false, status: 500, problem: "answered 500" });
    const log = await deliveriesOf(webhook.id);
    expect(log.map((d) => d.status).sort()).toEqual(["delivered", "failed"]);
  });

  it("resends with the same message id", async () => {
    const { webhook } = (await createHook()).body;
    answers = [500];
    await decide();
    for (let i = 0; i < 8; i++) {
      await worker.drain();
      later(11 * 3_600_000);
    }
    answers = [200];
    const [d] = await deliveriesOf(webhook.id);
    expect((await call("POST", `${hooksPath()}/${webhook.id}/resend`, { delivery: d.id })).body).toEqual({ queued: 1 });
    await worker.drain();
    expect((await deliveriesOf(webhook.id))[0]).toMatchObject({ status: "delivered", attempts: 1 });
    expect(new Set(received.map((r) => r.headers["webhook-id"])).size).toBe(1);
    expect((await call("POST", `${hooksPath()}/${webhook.id}/resend`, { status: "failed" })).body).toEqual({
      queued: 0,
    });
  });

  it("signs with both secrets for a day after a rotation", async () => {
    const { webhook, secret: first } = (await createHook()).body;
    const rotated = (await call("POST", `${hooksPath()}/${webhook.id}/rotate`, {})).body;
    expect(rotated.webhook.secret_hints).toHaveLength(2);
    await decide();
    await worker.drain();
    expect(String(received[0]!.headers["webhook-signature"]).split(" ")).toHaveLength(2);
    expect(verified(received[0]!, first)).toBe(true);
    expect(verified(received[0]!, rotated.secret)).toBe(true);

    later(24 * 3_600_000 + 1);
    await decide();
    await worker.drain();
    expect(verified(received[1]!, rotated.secret)).toBe(true);
    expect(verified(received[1]!, first)).toBe(false);

    const again = (await call("POST", `${hooksPath()}/${webhook.id}/rotate`, {})).body;
    const ended = (await call("POST", `${hooksPath()}/${webhook.id}/rotate`, { end_overlap: true })).body;
    expect(ended.secret).toBeNull();
    expect(ended.webhook.secret_hints).toHaveLength(1);
    expect(ended.webhook.secret_hints[0].expires).toBeUndefined();
    await decide();
    await worker.drain();
    expect(String(received[2]!.headers["webhook-signature"]).split(" ")).toHaveLength(1);
    expect(verified(received[2]!, again.secret)).toBe(true);
    expect((await call("POST", `${hooksPath()}/${webhook.id}/rotate`, { end_overlap: true })).body.error.type).toBe(
      "no_overlap",
    );
  });
});

describe("resolutions and decision.updated", () => {
  it("keeps the model's decision, changes the final outcome, and counts revisions", async () => {
    probability = 0.6;
    const { decision_id: id, decision } = (await decide()).body;
    expect(decision).toBe("review");
    let shown = (await call("GET", `/v1/decisions/${id}`)).body;
    expect(shown).toMatchObject({
      revision: 1,
      resolution: null,
      final_outcome: "review",
      request: { entities: { merchant: "m1", bank: "b7" }, properties: { usd: 4200 } },
    });

    const resolved = await call("POST", `/v1/decisions/${id}/resolution`, {
      outcome: "approve",
      note: "Called the customer.",
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      revision: 2,
      final_outcome: "approve",
      resolution: {
        outcome: "approve",
        note: "Called the customer.",
        by: "owner@example.com",
        at: START.toISOString(),
      },
    });
    expect(resolved.body).not.toHaveProperty("context");
    shown = (await call("GET", `/v1/decisions/${id}`)).body;
    expect(shown.decision.decision).toBe("review");
    expect(shown.final_outcome).toBe("approve");

    later(60_000);
    expect((await call("POST", `/v1/decisions/${id}/resolution`, { outcome: "block" })).body).toMatchObject({
      revision: 3,
      final_outcome: "block",
    });
    expect((await call("GET", "/v1/decisions?final_outcome=block")).body.decisions.map((d: any) => d.id)).toEqual([id]);
    expect((await call("GET", "/v1/decisions?outcome=review")).body.decisions[0]).toMatchObject({
      id,
      final_outcome: "block",
      revision: 3,
    });
  });

  it("lets a dashboard count by the final outcome", async () => {
    const first = (await decide()).body.decision_id;
    await decide();
    await call("POST", `/v1/decisions/${first}/resolution`, { outcome: "block" });
    const period = { source: "decisions", from: "2026-10-14T00:00:00Z", to: "2026-10-15T00:00:00Z" };
    const byFinal = (await call("POST", "/v1/metrics/query", { ...period, group_by: "final_outcome" })).body.series.map(
      (x: any) => [x.key, x.total],
    );
    expect(byFinal.sort()).toEqual([
      ["approve", 1],
      ["block", 1],
    ]);
    expect(
      (await call("POST", "/v1/metrics/query", { ...period, filters: { final_outcome: "block" } })).body.total,
    ).toBe(1);
    expect((await call("POST", "/v1/metrics/query", { ...period, filters: { outcome: "block" } })).body.total).toBe(0);
  });

  it("refuses a wrong outcome and an unknown decision", async () => {
    const { decision_id: id } = (await decide()).body;
    expect((await call("POST", `/v1/decisions/${id}/resolution`, { outcome: "review" })).status).toBe(400);
    expect((await call("POST", "/v1/decisions/kdec_none/resolution", { outcome: "approve" })).status).toBe(404);
  });

  it("sends decision.updated, complete, with the next revision", async () => {
    const { webhook } = (await createHook({ events: ["decision.created", "decision.updated"] })).body;
    const { decision_id: id } = (await decide({ session: "s_9" })).body;
    await call("POST", `/v1/decisions/${id}/resolution`, { outcome: "block", note: "Mule pattern." });
    await worker.drain();
    const messages = received.map((r) => JSON.parse(r.body));
    expect(messages.map((m) => [m.type, m.data.revision, m.data.final_outcome])).toEqual([
      ["decision.created", 1, "approve"],
      ["decision.updated", 2, "block"],
    ]);
    // The latest message alone is enough: everything is in it.
    expect(messages[1].data).toMatchObject({
      decision_id: id,
      decision: "approve",
      entities: { merchant: "m1", bank: "b7" },
      properties: { usd: 4200 },
      session: "s_9",
      resolution: { outcome: "block", note: "Mule pattern.", by: "owner@example.com" },
    });
    expect(messages[0].id).not.toBe(messages[1].id);
    const log = await deliveriesOf(webhook.id);
    expect(log.map((d) => d.type).sort()).toEqual(["decision.created", "decision.updated"]);
  });

  it("filters decision.updated on the final outcome", async () => {
    const blocks = (await createHook({ events: ["decision.updated"], filter: { outcomes: ["block"] } })).body.webhook;
    const { decision_id: id } = (await decide()).body;
    await call("POST", `/v1/decisions/${id}/resolution`, { outcome: "approve" });
    await call("POST", `/v1/decisions/${id}/resolution`, { outcome: "block" });
    await worker.drain();
    expect((await deliveriesOf(blocks.id)).length).toBe(1);
    expect(JSON.parse(received[0]!.body).data.revision).toBe(3);
  });

  it("takes `by` from an API key's request", async () => {
    const { decision_id: id } = (await decide()).body;
    const viaKey = await app.request(`/v1/decisions/${id}/resolution`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await secretKey()}` },
      body: JSON.stringify({ outcome: "approve", by: "case-tool:alice" }),
    });
    expect(((await viaKey.json()) as any).resolution.by).toBe("case-tool:alice");
  });
});

describe("label.created", () => {
  it("sends a new label with the recent decisions about the entity", async () => {
    await createHook({ events: ["label.created"] });
    const { decision_id: id } = (await decide()).body;
    later(3_600_000);
    expect(
      (
        await call("POST", "/v1/labels", {
          batch: [{ entity: { type: "merchant", id: "m1" }, label: "chargeback", properties: { amount: 4200 } }],
        })
      ).status,
    ).toBe(200);
    await worker.drain();
    const message = JSON.parse(received[0]!.body);
    expect(message).toMatchObject({
      type: "label.created",
      data: {
        entity: { type: "merchant", id: "m1" },
        label: "chargeback",
        labelled_at: clock.toISOString(),
        properties: { amount: 4200 },
      },
    });
    expect(message.data.recent_decisions).toEqual([
      {
        decision_id: id,
        action: "payout@1",
        decision: "approve",
        final_outcome: "approve",
        decided_at: START.toISOString(),
      },
    ]);
  });

  it("sends nothing for a label the entity had, or for an old one being imported", async () => {
    await createHook({ events: ["label.created"] });
    const label = (ts?: string) =>
      call("POST", "/v1/labels", {
        batch: [{ entity: { type: "merchant", id: "m1" }, label: "chargeback", ...(ts ? { ts } : {}) }],
      });
    await label();
    await label();
    await call("POST", "/v1/labels", {
      batch: [{ entity: { type: "merchant", id: "m2" }, label: "chargeback", ts: "2026-09-01T00:00:00Z" }],
    });
    await worker.drain();
    expect(received).toHaveLength(1);
  });

  it("filters on the label name", async () => {
    await createHook({ events: ["label.created"], filter: { labels: ["fraud_confirmed"] } });
    await call("POST", "/v1/labels", {
      batch: [
        { entity: { type: "merchant", id: "m1" }, label: "cleared" },
        { entity: { type: "merchant", id: "m1" }, label: "fraud_confirmed" },
      ],
    });
    await worker.drain();
    expect(received.map((r) => JSON.parse(r.body).data.label)).toEqual(["fraud_confirmed"]);
  });
});

describe("serverless: the first attempt kept alive, the retries from a scheduler", () => {
  const SECRET = "cron-secret-of-sixteen-or-more";
  const drain = (authorization?: string) =>
    app.request("/internal/webhooks/drain", { headers: authorization ? { Authorization: authorization } : {} });

  it("keeps the route closed without a secret, and refuses a wrong one", async () => {
    expect((await drain(`Bearer ${SECRET}`)).status).toBe(404);
    build({ cronSecret: SECRET });
    expect((await drain()).status).toBe(401);
    expect((await drain("Bearer wrong")).status).toBe(401);
    expect((await drain(`Bearer ${SECRET}x`)).status).toBe(401);
  });

  it("sends the retries that are due, and deletes old deliveries", async () => {
    build({ cronSecret: SECRET });
    ({ cookie, workspace } = await signup("cron@example.com"));
    await call("PUT", "/v1/actions/payout", { subject: "merchant", hold: "Should this payout be held?" });
    const { webhook } = (await createHook()).body;
    answers = [500, 200];
    await decide();
    await worker.drain();
    expect((await deliveriesOf(webhook.id))[0].status).toBe("pending");
    later(5_000);
    const response = await drain(`Bearer ${SECRET}`);
    expect(await response.json()).toEqual({ attempted: 1, deleted: 0 });
    expect((await deliveriesOf(webhook.id))[0]).toMatchObject({ status: "delivered", attempts: 2 });
    later(31 * 86_400_000);
    expect(await (await drain(`Bearer ${SECRET}`)).json()).toEqual({ attempted: 0, deleted: 1 });
  });

  it("hands the first attempt to waitUntil, which keeps the function alive", async () => {
    const kept: Promise<unknown>[] = [];
    const context = Symbol.for("@vercel/request-context");
    (globalThis as any)[context] = { get: () => ({ waitUntil: (p: Promise<unknown>) => kept.push(p) }) };
    try {
      const { waitUntil } = await import("../src/platform/wait-until");
      const deferred = createWebhookWorker({
        db: database.db,
        jobs,
        secretBox: box,
        now: () => clock,
        allowPrivate: true,
        log: () => {},
        defer: waitUntil,
      });
      hooks.worker = deferred;
      await createHook();
      await decide();
      expect(kept).toHaveLength(1);
      await Promise.all(kept);
      expect(received).toHaveLength(1);
    } finally {
      delete (globalThis as any)[context];
    }
  });

  it("stops starting batches when its time is up", async () => {
    await createHook();
    for (let i = 0; i < 3; i++) await decide();
    expect(await worker.drain({ budgetMs: 1 })).toBe(0);
    expect(await worker.drain({ budgetMs: 60_000 })).toBe(3);
  });

  it("tells admins when retries have no scheduler", async () => {
    build({ warning: "Retries need a scheduler." });
    expect((await call("GET", hooksPath())).body.warning).toBe("Retries need a scheduler.");
  });
});

it("deletes a workspace's webhooks and deliveries with it", async () => {
  await createHook();
  await decide();
  await database.db.execute<Record<string, any>>(sql`DELETE FROM workspaces WHERE id = ${workspace}`);
  expect(
    (await database.db.execute<Record<string, any>>(sql`SELECT COUNT(*)::int AS n FROM webhooks`)).rows[0],
  ).toEqual({ n: 0 });
  expect((await database.db.select().from(webhookDeliveries)).length).toBe(0);
});
