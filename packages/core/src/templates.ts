/**
 * An event template: a recommended shape for one event type. Kairos accepts any event, so
 * a template constrains nothing. It documents which entities an event should name and
 * which properties it usually carries, with an example that follows its own schema.
 */
export interface EventTemplate {
  type: string;
  description: string;
  /** Entity type → what it is in this event, and whether the event is of little use without it. */
  entities: Record<string, { description: string; required?: boolean }>;
  /** Property name → its type and meaning. */
  properties: Record<string, { type: "string" | "number" | "boolean"; description: string; enum?: string[] }>;
  /** Present when the event is a stage of a record: send every stage with the same `universalId` and a `status`. */
  record?: { statuses: string[]; description?: string };
  /** Properties for `track(type, example)`, written as the SDK takes them (`userId`, `universalId`, ...). */
  example: Record<string, unknown>;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SPECIAL = new Set(["universalId", "status", "eventId", "timestamp"]);

/** userId → user, bankAccountId → bank_account. The same rule as the SDK. */
function entityOf(key: string): string | undefined {
  const match = /^(.+?)(?:Id|_id)$/.exec(key);
  return match ? match[1]!.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase() : undefined;
}

/** Returns a list of problems; empty when the template is well formed and its example follows it. */
export function validateEventTemplate(t: EventTemplate): string[] {
  const problems: string[] = [];
  if (!t.type?.trim()) problems.push("type is missing");
  if (!t.description?.trim()) problems.push("description is missing");
  for (const [name, e] of Object.entries(t.entities ?? {})) {
    if (!NAME.test(name)) problems.push(`entities.${name}: not a valid entity type`);
    if (!e.description?.trim()) problems.push(`entities.${name}: description is missing`);
  }
  if (!Object.values(t.entities ?? {}).some((e) => e.required)) problems.push("at least one entity must be required");
  for (const [name, p] of Object.entries(t.properties ?? {})) {
    if (!["string", "number", "boolean"].includes(p.type))
      problems.push(`properties.${name}: type must be string, number or boolean`);
    if (!p.description?.trim()) problems.push(`properties.${name}: description is missing`);
  }

  const named = new Set<string>();
  for (const [key, value] of Object.entries(t.example ?? {})) {
    if (SPECIAL.has(key)) continue;
    const entity = entityOf(key);
    if (entity) {
      named.add(entity);
      if (!(entity in (t.entities ?? {}))) problems.push(`example.${key}: entity "${entity}" is not in entities`);
      continue;
    }
    const property = t.properties?.[key];
    if (!property) problems.push(`example.${key}: not in properties`);
    else if (typeof value !== property.type) problems.push(`example.${key}: should be a ${property.type}`);
    else if (property.enum && !property.enum.includes(String(value)))
      problems.push(`example.${key}: "${String(value)}" is not one of its values`);
  }
  for (const [name, e] of Object.entries(t.entities ?? {})) {
    if (e.required && !named.has(name)) problems.push(`example: the required entity "${name}" is missing`);
  }
  if (t.record) {
    if (!t.record.statuses?.length) problems.push("record.statuses is empty");
    if (typeof t.example?.universalId !== "string") problems.push("example: a record needs a universalId");
    if (!t.record.statuses?.includes(String(t.example?.status)))
      problems.push("example: status must be one of record.statuses");
  } else if (t.example?.universalId !== undefined || t.example?.status !== undefined) {
    problems.push("example: universalId and status belong to a template with a record");
  }
  return problems;
}
