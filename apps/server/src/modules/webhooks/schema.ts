import { z } from "zod";
import { EVENT_TYPES, OUTCOMES } from "./types";

const name = z.string().trim().min(1).max(100);
const url = z.string().trim().min(1).max(2000);
const shop = z.string().trim().toLowerCase().min(1).max(100);
const events = z.array(z.enum(EVENT_TYPES)).min(1, "must name at least one event type").max(EVENT_TYPES.length);
const filter = z
  .object({
    actions: z.array(z.string().trim().min(1)).max(50).optional(),
    outcomes: z.array(z.enum(OUTCOMES)).max(OUTCOMES.length).optional(),
    min_risk_score: z.number().int().min(0).max(100).optional(),
    labels: z.array(z.string().trim().min(1)).max(50).optional(),
    queues: z.array(z.string().trim().min(1)).max(50).optional(),
    commands: z.array(z.string().trim().min(1)).max(50).optional(),
  })
  .strict();

export const createWebhookBody = z.discriminatedUnion("direction", [
  z
    .object({
      direction: z.literal("out"),
      name,
      url,
      events,
      filter: filter.default({}),
      include_properties: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      direction: z.literal("in"),
      name,
      verification: z.record(z.unknown()),
      secret: z.string().min(1).max(500).optional(),
      mapping: z.unknown(),
      preset: z.string().max(64).optional(),
    })
    .strict(),
]);

export const updateSourceBody = z
  .object({
    name,
    verification: z.record(z.unknown()),
    mapping: z.unknown(),
    enabled: z.boolean(),
    secret: z.string().min(1).max(500),
    /** Adds a second secret, for a rotation at the provider; the oldest goes when there would be three. */
    add_secret: z.string().min(1).max(500),
    /** To import the shop's past orders. Null disconnects the shop. */
    shopify: z
      .union([
        z.object({ shop, token: z.string().trim().min(1).max(500) }).strict(),
        z
          .object({
            shop,
            client_id: z.string().trim().min(1).max(200),
            client_secret: z.string().trim().min(1).max(500),
          })
          .strict(),
      ])
      .nullable(),
  })
  .partial()
  .strict();

export const replayBody = z.union([
  z.object({ delivery: z.string().min(1) }).strict(),
  z.object({ status: z.literal("failed") }).strict(),
]);

export const previewBody = z
  .object({ mapping: z.unknown(), body: z.unknown(), headers: z.record(z.string()).default({}) })
  .strict();

export const updateWebhookBody = z
  .object({ name, url, events, filter, include_properties: z.boolean(), enabled: z.boolean() })
  .partial()
  .strict();

export const rotateBody = z.object({ end_overlap: z.boolean().default(false) }).strict();

export const resendBody = z.union([
  z.object({ delivery: z.string().min(1) }).strict(),
  z.object({ status: z.literal("failed"), since: z.string().datetime({ offset: true }).optional() }).strict(),
]);

export const backfillBody = z
  .object({ since: z.union([z.string().date(), z.string().datetime({ offset: true })]) })
  .strict();
