import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ALL_TABLES, decisions, environments, eventEntities, events, labels, objects } from "../src/db/schema";
import { relations } from "../src/db/relations";
import { testDatabase } from "./helpers/database";

const { db, reset } = await testDatabase();
const at = new Date("2026-03-01T10:00:00Z");
const WS = "ws_rel";

/** One workspace with two environments, and the same customer ids in both. */
async function seed() {
  await reset({ sk_rel: WS });
  const prod = WS;
  const sandbox = "env_sandbox";
  await db
    .insert(environments)
    .values({ id: sandbox, workspaceId: WS, name: "Sandbox", kind: "sandbox", created: at, updated: at });
  for (const env of [prod, sandbox]) {
    const event = {
      workspaceId: WS,
      environmentId: env,
      ts: at,
      entities: { user: "u1" },
      properties: {},
      created: at,
    };
    await db.insert(events).values([
      { ...event, id: `evt_${env}_1`, externalId: "e1", type: "payout" },
      { ...event, id: `evt_${env}_2`, externalId: "e2", type: "login" },
    ]);
    await db.insert(eventEntities).values(
      [1, 2].map((n) => ({
        workspaceId: WS,
        environmentId: env,
        entityType: "user",
        entityId: "u1",
        ts: at,
        eventId: `evt_${env}_${n}`,
        created: at,
      })),
    );
    for (const user of ["u1", "u2"]) {
      await db.insert(objects).values({
        id: `obj_${env}_${user}`,
        workspaceId: WS,
        environmentId: env,
        type: "user",
        externalId: user,
        properties: {},
        firstSeen: at,
        created: at,
        updated: at,
      });
    }
    await db.insert(decisions).values({
      id: `kdec_${env}`,
      workspaceId: WS,
      environmentId: env,
      ts: at,
      action: "hold@1",
      subjectType: "user",
      subjectId: "u1",
      decision: { decision: "block" },
      context: {},
      raw: {},
      eventId: `evt_${env}_1`,
      created: at,
      updated: at,
    });
  }
  // Only the sandbox knows that u2 is fraud.
  await db.insert(labels).values({
    id: "lbl_1",
    workspaceId: WS,
    environmentId: sandbox,
    entityType: "user",
    entityId: "u2",
    label: "fraud",
    ts: at,
    properties: {},
    created: at,
    updated: at,
  });
  return { prod, sandbox };
}

describe("relations", () => {
  it("gives every table at least one relation", () => {
    const related = new Set(
      Object.values(relations)
        .filter((r) => Object.keys(r.relations).length > 0)
        .map((r) => getTableName(r.table)),
    );
    expect(ALL_TABLES.filter((table) => !related.has(table))).toEqual([]);
  });

  it("filters by a related row, and loads it", async () => {
    const { prod } = await seed();
    const found = await db.query.decisions.findMany({
      where: { workspaceId: WS, environmentId: prod, event: { type: "payout" } },
      with: { event: { columns: { externalId: true, type: true } }, subject: { columns: { externalId: true } } },
    });
    expect(found.map((d) => ({ id: d.id, event: d.event, subject: d.subject }))).toEqual([
      { id: `kdec_${prod}`, event: { externalId: "e1", type: "payout" }, subject: { externalId: "u1" } },
    ]);
    expect(
      await db.query.decisions.findMany({ where: { workspaceId: WS, environmentId: prod, event: { type: "login" } } }),
    ).toEqual([]);
  });

  it("follows an entity's customer id only inside its own environment", async () => {
    const { prod, sandbox } = await seed();
    const fraud = (environmentId: string) =>
      db.query.objects.findMany({
        where: { workspaceId: WS, environmentId, labels: { label: "fraud" } },
        columns: { externalId: true },
        with: { labels: { columns: { label: true } } },
      });
    expect(await fraud(sandbox)).toEqual([{ externalId: "u2", labels: [{ label: "fraud" }] }]);
    // The same u2 in production has no label: the label of the sandbox is not its label.
    expect(await fraud(prod)).toEqual([]);
    const timeline = await db.query.objects.findFirst({
      where: { workspaceId: WS, environmentId: prod, externalId: "u1" },
      with: { links: { with: { event: { columns: { externalId: true } } } } },
    });
    expect(timeline!.links.map((l) => l.event.externalId).sort()).toEqual(["e1", "e2"]);
  });
});
