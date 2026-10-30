import { z } from "zod";

export const name = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'must be a name such as "user" or "bank_transfer"');
/** An action at its live version ("withdrawal"), or at one saved version ("withdrawal@3"). */
export const actionRef = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]{0,63}(@[1-9][0-9]*)?$/,
    'must be an action name, or a name and a version such as "withdrawal@3"',
  );
export const id = z.string().min(1).max(256);
export const properties = z.record(z.unknown()).default({});
/** Entity type → id. */
export const entities = z.record(name, id);
export const timestamp = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO 8601 timestamp");
