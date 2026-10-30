import { z } from "zod";
import { actionRef, entities, id, name, properties, timestamp } from "../../platform/fields";

export const eventBody = z
  .object({
    id,
    type: z.string().min(1).max(128),
    ts: timestamp,
    entities: entities.refine((e) => Object.keys(e).length > 0, "needs at least one entity"),
    properties,
    // Stages of one record share a universal id; the status is the record's state at this stage.
    universal_id: id.optional(),
    status: z.string().min(1).max(64).optional(),
    session: id.optional(),
    set: z.record(name, z.record(z.unknown())).optional(),
    set_once: z.record(name, z.record(z.unknown())).optional(),
  })
  .superRefine((event, ctx) => {
    for (const field of ["set", "set_once"] as const) {
      for (const type of Object.keys(event[field] ?? {})) {
        if (!(type in event.entities))
          ctx.addIssue({ code: "custom", path: [field, type], message: `the event names no "${type}" entity` });
      }
    }
  });
export type IncomingEvent = z.infer<typeof eventBody>;

export const eventsBody = z.object({ batch: z.array(eventBody).min(1).max(500) });
export const objectsBody = z.object({
  batch: z
    .array(z.object({ type: name, id, properties }))
    .min(1)
    .max(500),
});
export const entityBody = z.object({
  properties,
  unset: z.array(z.string().min(1).max(200)).max(200).default([]),
});
export const labelsBody = z.object({
  batch: z
    .array(z.object({ entity: z.object({ type: name, id }), label: name, ts: timestamp.optional(), properties }))
    .min(1)
    .max(500),
});
export const resolutionBody = z
  .object({
    outcome: z.enum(["approve", "block"]),
    note: z.string().trim().max(2000).optional(),
    by: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const decideBody = z.object({
  action: actionRef,
  entities,
  properties,
  ts: timestamp.optional(),
  session: id.optional(),
});
