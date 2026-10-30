import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { triggersOverlap, validateAction, type ActionDefinition } from "@kairos/core";
import type { Executor } from "../../platform/database";
import { invalid } from "../../platform/error";
import { ActionsService } from "../../services/action.service";
import { saveVersion } from "../../services/definition_version.service";

export function loadTemplates(dir: string): ActionDefinition[] {
  const actions = join(dir, "actions");
  try {
    return readdirSync(actions)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => JSON.parse(readFileSync(join(actions, file), "utf8")) as ActionDefinition)
      .filter((t) => validateAction(t).length === 0);
  } catch {
    return []; // no templates directory: the API works without it
  }
}

/**
 * Save a definition as the next version of its action. It is not validated: see `putAction`.
 * The display name and the automatic switch are not shown to the model: a change of either
 * changes no answer, so it is not a new version — it changes the columns of the live row.
 */
export async function saveAction(
  db: Executor,
  workspaceId: string,
  environmentId: string,
  definition: ActionDefinition,
  now: Date,
  by: string | null = null,
): Promise<ActionDefinition> {
  const { version: _ignored, displayName, automatic, automaticSince: _sent, ...body } = definition;
  const scope = { workspaceId, environmentId };
  return db.transaction(async (tx) => {
    const saved = await saveVersion(tx, scope, "action", definition.name, body, by, now);
    const actions = new ActionsService(tx, scope);
    const current = await actions.findLatest(definition.name);
    // The moment automatic decisions were turned on is the server's: kept while they stay on.
    const since = automatic
      ? current?.automatic && current.automaticSince
        ? current.automaticSince
        : now.toISOString()
      : null;
    const live: ActionDefinition = {
      ...body,
      ...(displayName ? { displayName } : {}),
      ...(automatic ? { automatic: true, ...(since ? { automaticSince: since } : {}) } : {}),
      version: saved.version,
    };
    const columns = {
      version: saved.version,
      definition: body,
      displayName: displayName ?? null,
      automatic: !!automatic,
      automaticSince: since ? new Date(since) : null,
    };
    if (!current) {
      await actions.create({ name: definition.name, ...columns }, now);
      return live;
    }
    const columnsChanged =
      (current.displayName ?? undefined) !== (displayName || undefined) || !!current.automatic !== !!automatic;
    if (!saved.changed && !columnsChanged) return current;
    await actions.updateMany({ name: definition.name }, columns, now);
    return live;
  });
}

export async function putAction(
  db: Executor,
  workspaceId: string,
  environmentId: string,
  name: string,
  body: Partial<ActionDefinition> | null,
  now: Date,
  by: string | null = null,
): Promise<ActionDefinition> {
  if (!body || typeof body !== "object") throw invalid("body: must be an action definition");
  const definition = { ...body, name } as ActionDefinition;
  delete definition.version;
  const problems = validateAction(definition);
  if (problems.length) throw invalid(problems.join("; "));
  // One event type starts one action, so that an event has one decision.
  const taken =
    definition.trigger &&
    (await new ActionsService(db, { workspaceId, environmentId }).listLatest()).find(
      (a) => a.name !== definition.name && triggersOverlap(a, definition),
    );
  if (taken) throw invalid(`trigger: this event already starts the action "${taken.name}"`);
  return saveAction(db, workspaceId, environmentId, definition, now, by);
}
