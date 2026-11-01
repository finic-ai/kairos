/** What an event's properties mean, the same in every client. */

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** userId → user, bankAccountId → bank_account, recipient_id → recipient. */
function entityType(key: string): string | undefined {
  const match = /^(.+?)(?:Id|_id)$/.exec(key);
  return match ? match[1]!.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase() : undefined;
}

/** Split properties into entity references and everything else. */
export function split(input: Record<string, unknown>): {
  entities: Record<string, string>;
  properties: Record<string, unknown>;
} {
  const entities: Record<string, string> = {};
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const type = entityType(key);
    if (key === "entities" && value && typeof value === "object") Object.assign(entities, value);
    else if (type && (typeof value === "string" || typeof value === "number") && value !== "")
      entities[type] = String(value);
    else if (value !== undefined) properties[key] = value;
  }
  return { entities, properties };
}
