import { describe, expect, it } from "vitest";
import { DatabaseService } from "../src/platform/orm";
import { testDatabase } from "./helpers/database";

const { db, reset } = await testDatabase();
const T1 = new Date("2026-01-01T00:00:00Z");
const T2 = new Date("2026-01-01T01:00:00Z");
// The test helper makes each workspace with a production environment of the same id.
const A = { workspaceId: "ws_a", environmentId: "ws_a" };
const B = { workspaceId: "ws_b", environmentId: "ws_b" };
const object = (externalId: string) => ({ type: "user", externalId, properties: { name: externalId }, firstSeen: T1 });
const label = (entityId: string) => ({ entityType: "user", entityId, label: "fraud", ts: T1, properties: {} });

async function seed() {
  await reset({ sk_a: "ws_a", sk_b: "ws_b" });
  const objects = { a: new DatabaseService(db, "objects", A), b: new DatabaseService(db, "objects", B) };
  await objects.a.createMany([object("u1"), object("u2")], T1);
  await objects.b.create(object("u1"), T1);
  // In A, u2 is fraud. In B, u1 is: the same customer id, in another scope.
  await new DatabaseService(db, "labels", A).create(label("u2"), T1);
  await new DatabaseService(db, "labels", B).create(label("u1"), T1);
  return objects;
}

describe("DatabaseService", () => {
  it("makes the id and the times, and writes the scope itself", async () => {
    const { a } = await seed();
    const [row] = await a.findMany({ where: { externalId: "u1" } });
    expect(row).toMatchObject({ ...A, type: "user", externalId: "u1", created: T1, updated: T1 });
    expect(row!.id).toMatch(/^obj_[0-9a-hjkmnp-tv-z]{26}$/);
    // @ts-expect-error The scope is not a value a caller writes.
    await expect(a.create({ ...object("u3"), workspaceId: "ws_b" }, T1)).resolves.toMatchObject({
      workspaceId: "ws_a",
    });
  });

  it("reads only its own scope, even through OR", async () => {
    const { a, b } = await seed();
    expect(
      (await a.findMany({ columns: { externalId: true }, orderBy: { externalId: "asc" } })).map((r) => r.externalId),
    ).toEqual(["u1", "u2"]);
    expect(
      (
        await b.findMany({ where: { OR: [{ externalId: "u1" }, { externalId: "u2" }] }, columns: { externalId: true } })
      ).map((r) => r.externalId),
    ).toEqual(["u1"]);
    expect(await a.count()).toBe(2);
    expect(await b.count({ externalId: { in: ["u1", "u2"] } })).toBe(1);
  });

  it("filters through relations, inside the scope", async () => {
    const { a, b } = await seed();
    const fraud = { labels: { label: "fraud" } } as const;
    expect(
      await a.findMany({ where: fraud, columns: { externalId: true }, with: { labels: { columns: { label: true } } } }),
    ).toEqual([{ externalId: "u2", labels: [{ label: "fraud" }] }]);
    expect(await b.findMany({ where: fraud, columns: { externalId: true } })).toEqual([{ externalId: "u1" }]);
  });

  it("changes a row: `updated` moves, and the id, the scope and `created` stay", async () => {
    const { a } = await seed();
    const row = (await a.findFirst({ where: { externalId: "u1" } }))!;
    const changed = await a.update(
      row.id,
      { properties: { name: "Ada" }, ...({ id: "obj_other", workspaceId: "ws_b", created: T2 } as object) },
      T2,
    );
    expect(changed).toMatchObject({ id: row.id, ...A, properties: { name: "Ada" }, created: T1, updated: T2 });
  });

  it("does not find, change or delete a row of another scope", async () => {
    const { a, b } = await seed();
    const theirs = (await b.findFirst({ where: { externalId: "u1" } }))!;
    expect(await a.findById(theirs.id)).toBeNull();
    expect(await a.update(theirs.id, { properties: { name: "taken" } }, T2)).toBeNull();
    expect(await a.delete(theirs.id)).toBe(false);
    expect(await b.findById(theirs.id, { columns: { properties: true } })).toEqual({ properties: { name: "u1" } });
    expect(await b.delete(theirs.id)).toBe(true);
    expect(await b.count()).toBe(0);
  });

  it("works inside a transaction", async () => {
    await seed();
    await expect(
      db.transaction(async (tx) => {
        await new DatabaseService(tx, "objects", A).create(object("u9"), T1);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(await new DatabaseService(db, "objects", A).count({ externalId: "u9" })).toBe(0);
  });

  it("upserts inside the scope, and says whether the row is new", async () => {
    await seed();
    const labels = { a: new DatabaseService(db, "labels", A), b: new DatabaseService(db, "labels", B) };
    const key = ["entityType", "entityId", "label"] as const;
    const first = await labels.a.upsert(label("u7"), T1, [...key], { ts: T1 });
    expect(first.inserted).toBe(true);
    const again = await labels.a.upsert({ ...label("u7"), properties: { why: "chargeback" } }, T2, [...key], {
      ts: T2,
      properties: { why: "chargeback" },
    });
    expect(again).toMatchObject({
      inserted: false,
      row: { id: first.row.id, ts: T2, properties: { why: "chargeback" }, created: T1, updated: T2 },
    });
    // The same key in another scope is another row.
    expect((await labels.b.upsert(label("u7"), T2, [...key], { ts: T2 })).inserted).toBe(true);
    expect(await labels.a.createIfMissing(label("u7"), T2, [...key])).toBe(false);
    expect(await labels.a.createIfMissing(label("u8"), T2, [...key])).toBe(true);
  });

  it("changes and deletes the rows of a filter, only in the scope", async () => {
    const { a, b } = await seed();
    const changed = await a.updateMany(
      { externalId: { in: ["u1", "u2"] }, firstSeen: { lte: T1 } },
      { properties: { seen: true } },
      T2,
    );
    expect(changed.map((r) => [r.externalId, r.updated])).toEqual(
      expect.arrayContaining([
        ["u1", T2],
        ["u2", T2],
      ]),
    );
    expect((await b.findFirst({ where: { externalId: "u1" } }))!.properties).toEqual({ name: "u1" });
    expect((await a.deleteMany({ externalId: "u1" })).length).toBe(1);
    expect(await b.count({ externalId: "u1" })).toBe(1);
  });

  it("records activity without moving `updated`, and takes an id made by newId", async () => {
    await reset({ sk_a: "ws_a" });
    const webhooks = new DatabaseService(db, "webhooks", A);
    const hook = await webhooks.create(
      {
        direction: "out",
        name: "Hook",
        secrets: [],
        config: { events: [], include_properties: true, version: 1 },
        url: "https://example.com",
      },
      T1,
      { id: "wh_given" },
    );
    expect(hook.id).toBe("wh_given");
    await webhooks.updateActivity(hook.id, { lastDelivery: T2 });
    expect(await webhooks.findById(hook.id, { columns: { lastDelivery: true, updated: true } })).toEqual({
      lastDelivery: T2,
      updated: T1,
    });
  });

  it("refuses an empty scope", () => {
    expect(() => new DatabaseService(db, "decisions", { workspaceId: "ws_a", environmentId: "" })).toThrow(
      "needs environmentId",
    );
  });

  it("writes a global table only through a filter", async () => {
    await seed();
    const users = new DatabaseService(db, "users", {});
    const ada = await users.create(
      { email: "ada@example.com", auth: { provider: "native", strategy: "email_password" }, passwordHash: "x" },
      T1,
    );
    expect(ada.id).toMatch(/^usr_/);
    await expect(users.updateMany({}, { displayName: "Everyone" }, T2)).rejects.toThrow("needs a filter");
    await expect(users.deleteMany({})).rejects.toThrow("needs a filter");
    expect((await users.update(ada.id, { displayName: "Ada" }, T2))?.displayName).toBe("Ada");
  });
});
