import { z } from "zod";
import { OUTCOMES } from "../webhooks/types";
import {
  CONSENT,
  DATA_KINDS,
  ROUTING_MODES,
  FIELD_KINDS,
  FIELD_SOURCES,
  HTTP_METHODS,
  OTHER_REQUESTS,
  ROUTE_MODES,
} from "./types";

const eventType = z.string().trim().min(1).max(128);
const propertyName = z
  .string()
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must start with a letter or _, then letters, digits or _");
// The characters RFC 6265 allows in a cookie name.
const cookieName = z
  .string()
  .trim()
  .max(128)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, "is not a cookie name");

const route = z
  .string()
  .trim()
  .transform((text, ctx) => {
    const match = /^([A-Za-z]+)\s+(\/\S*)$/.exec(text);
    const method = (match?.[1] ?? "").toUpperCase();
    if (!match || !(HTTP_METHODS as readonly string[]).includes(method)) {
      ctx.addIssue({ code: "custom", message: `"${text}" must be a method and a path, such as "POST /payees/:id"` });
      return z.NEVER;
    }
    const path = match[2]!;
    return `${method} ${path.length > 1 ? path.replace(/\/+$/, "") || "/" : path}`;
  });

const field = z
  .object({
    from: z.enum(FIELD_SOURCES).optional(),
    path: z.string().trim().min(1).max(256).optional(),
    value: z.union([z.string().max(256), z.number(), z.boolean()]).optional(),
    kind: z.enum(FIELD_KINDS).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.value !== undefined && (f.from || f.path))
      ctx.addIssue({ code: "custom", message: "a field has a value, or a from and a path, not both" });
    if (f.value === undefined && (!f.from || !f.path))
      ctx.addIssue({ code: "custom", message: "a field needs a from and a path, or a value" });
  });

const routeEntry = z
  .object({
    route,
    mode: z.enum(ROUTE_MODES),
    type: eventType,
    failed: eventType.optional(),
    fields: z
      .record(propertyName, field)
      .refine((f) => Object.keys(f).length <= 30, "at most 30 fields")
      .default({}),
    fallback: z.enum(OUTCOMES).optional(),
    timeoutMs: z.number().int().min(100).max(10_000).optional(),
    block: z
      .object({
        status: z.number().int().min(400).max(599),
        body: z
          .unknown()
          .optional()
          .refine((b) => b === undefined || JSON.stringify(b).length <= 4096, "at most 4096 characters"),
      })
      .strict()
      .optional(),
    stepUp: z
      .union([z.literal("forward"), z.object({ redirect: z.string().trim().startsWith("/").max(512) }).strict()])
      .optional(),
    enforce: z.boolean().default(false),
  })
  .strict()
  .superRefine((r, ctx) => {
    const decides = r.mode !== "track";
    if (decides && !r.fallback)
      ctx.addIssue({ code: "custom", path: ["fallback"], message: "a route that decides needs a fallback" });
    if (!decides)
      for (const key of ["fallback", "timeoutMs", "block", "stepUp"] as const)
        if (r[key] !== undefined)
          ctx.addIssue({ code: "custom", path: [key], message: "only a route that decides has this" });
    if (!decides && r.enforce)
      ctx.addIssue({ code: "custom", path: ["enforce"], message: "only a route that decides is enforced" });
  });

const unique = <T>(list: T[], key: (item: T) => string, what: string, ctx: z.RefinementCtx, path: string) => {
  const seen = new Set<string>();
  list.forEach((item, i) => {
    const k = key(item);
    if (seen.has(k)) ctx.addIssue({ code: "custom", path: [path, i], message: `${what} "${k}" is there twice` });
    seen.add(k);
  });
};

const settingsObject = z
  .object({
    consent: z.enum(CONSENT),
    defaults: z
      .object({
        country: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{2}$/, "must be a two-letter country code, such as GB")
          .optional(),
        off: z.array(z.enum(DATA_KINDS)).max(DATA_KINDS.length).default([]),
        sessionCookie: cookieName.optional(),
      })
      .strict(),
    routing: z
      .object({ mode: z.enum(ROUTING_MODES), other: z.enum(OTHER_REQUESTS) })
      .strict()
      .default({ mode: "monitor", other: "ignore" }),
    pages: z
      .array(
        z.object({ path: z.string().trim().startsWith("/", "must start with /").max(512), type: eventType }).strict(),
      )
      .max(200),
    screens: z.array(z.object({ name: z.string().trim().min(1).max(128), type: eventType }).strict()).max(200),
    routes: z.array(routeEntry).max(100),
  })
  .strict();

const checks = (c: z.output<typeof settingsObject>, ctx: z.RefinementCtx) => {
  unique(c.pages, (p) => p.path, "The page", ctx, "pages");
  unique(c.screens, (s) => s.name, "The screen", ctx, "screens");
  unique(c.routes, (r) => r.route, "The route", ctx, "routes");
};

/** What an admin saves for one environment. The server sets `version`. */
export const clientSettingsBody = settingsObject.superRefine(checks);

/** What the workspace keeps for one environment: a saved body and its version. */
export const storedClientSettings = settingsObject.extend({ version: z.number().int().min(1) }).superRefine(checks);
