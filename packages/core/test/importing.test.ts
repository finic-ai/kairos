import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkEventMapping,
  checkLabelMapping,
  csvReader,
  entityFromRow,
  eventFromRow,
  importRowId,
  importTime,
  importValue,
  labelFromRow,
  parseCsv,
  parseImportFile,
  parseJsonLines,
  suggestIdColumn,
  type EventImportMapping,
  type ImportRow,
} from "../src/index";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("reading a CSV file", () => {
  it("reads quoted cells, doubled quotes, line breaks inside quotes, CRLF and a byte-order mark", () => {
    const file = parseCsv('﻿id,name,note\r\nc1,"Smith, Ada","said ""hi"""\r\n\r\nc2,Ben,"two\nlines"\r\nc3,Cy,\n');
    expect(file.columns).toEqual(["id", "name", "note"]);
    expect(file.rows).toEqual([
      { line: 2, values: { id: "c1", name: "Smith, Ada", note: 'said "hi"' } },
      { line: 4, values: { id: "c2", name: "Ben", note: "two\nlines" } },
      { line: 6, values: { id: "c3", name: "Cy", note: "" } },
    ]);
  });

  it("reads another delimiter, marks a row with too many cells, and fills a short row", () => {
    const file = parseCsv("id;country\nc1;GB;extra\nc2\n", ";");
    expect(file.rows[0]).toMatchObject({ line: 2, broken: "the row has more cells than the header" });
    expect(file.rows[1]).toEqual({ line: 3, values: { id: "c2", country: "" } });
  });

  it("reads the same rows when the file comes in parts of any size", () => {
    const text = '﻿id,name,note\r\nc1,"Smith, Ada","said ""hi"""\r\n\r\nc2,Ben,"two\r\nlines"\r\nc3,Cy,';
    for (const size of [1, 2, 3, 7]) {
      const reader = csvReader();
      const rows: ImportRow[] = [];
      for (let i = 0; i < text.length; i += size) rows.push(...reader.push(text.slice(i, i + size)));
      rows.push(...reader.end());
      expect(rows, `parts of ${size}`).toEqual(parseCsv(text).rows);
    }
  });

  it("has no rows for an empty file or a header alone", () => {
    expect(parseCsv("")).toEqual({ columns: [], rows: [] });
    expect(parseCsv("id,country\n")).toEqual({ columns: ["id", "country"], rows: [] });
  });
});

describe("reading a JSON-lines file", () => {
  it("collects the columns in the order first seen and marks a bad line", () => {
    const file = parseJsonLines('{"id":"c1","age":41}\n\nnot json\n[1]\n{"id":"c2","plan":"pro"}\n');
    expect(file.columns).toEqual(["id", "age", "plan"]);
    expect(file.rows.map((r) => [r.line, r.broken ? "broken" : "ok"])).toEqual([
      [1, "ok"],
      [3, "broken"],
      [4, "broken"],
      [5, "ok"],
    ]);
  });

  it("is chosen by the file name", () => {
    expect(parseImportFile("people.jsonl", '{"id":"c1"}').rows[0]!.values).toEqual({ id: "c1" });
    expect(parseImportFile("people.CSV", "id\nc1").rows[0]!.values).toEqual({ id: "c1" });
  });
});

describe("values: the same rules as the Python importer", () => {
  it("types plain numbers and true/false, and keeps codes and long numbers as text", () => {
    const cases: [unknown, unknown][] = [
      ["95.50", 95.5],
      ["3", 3],
      ["-12", -12],
      ["0", 0],
      ["0.5", 0.5],
      ["02139", "02139"],
      ["4242424242424242", "4242424242424242"],
      ["1e5", "1e5"],
      ["12.", "12."],
      ["TRUE", true],
      ["false", false],
      ["", undefined],
      ["   ", undefined],
      ["  abc ", "abc"],
      [7, 7],
      [{ a: 1 }, { a: 1 }],
      [null, undefined],
    ];
    for (const [raw, stored] of cases) expect(importValue(raw), String(raw)).toEqual(stored);
    expect(importValue("5", false)).toBe("5");
  });
});

describe("a row as an entity", () => {
  const mapping = { type: "user", id: "customer_id", exclude: ["password"], text: ["zip"] };

  it("takes the id from its column and every other column as a property", () => {
    expect(
      entityFromRow(
        { line: 2, values: { customer_id: " c1 ", country: "GB", age: "41", zip: "02139", password: "x", note: "" } },
        mapping,
      ),
    ).toEqual({
      ok: true,
      entity: { type: "user", id: "c1", properties: { country: "GB", age: 41, zip: "02139" } },
    });
    expect(
      entityFromRow(
        { line: 2, values: { customer_id: "c1", country: "GB", age: "41" } },
        { ...mapping, include: ["age"] },
      ),
    ).toMatchObject({ entity: { properties: { age: 41 } } });
  });

  it("gives the reason a row cannot be used", () => {
    expect(entityFromRow({ line: 2, values: { country: "GB" } }, mapping)).toEqual({ ok: false, reason: "no id" });
    expect(entityFromRow({ line: 2, values: { customer_id: "x".repeat(300) } }, mapping)).toEqual({
      ok: false,
      reason: "the id is longer than 256 characters",
    });
    expect(entityFromRow({ line: 2, values: {}, broken: "not JSON: x" }, mapping)).toEqual({
      ok: false,
      reason: "not JSON: x",
    });
  });
});

describe("the suggested id column", () => {
  it("prefers the type's own id, then id, then any column that ends in _id", () => {
    expect(suggestIdColumn(["email", "user_id", "id"], "user")).toBe("user_id");
    expect(suggestIdColumn(["email", "bankAccountId"], "bank_account")).toBe("bankAccountId");
    expect(suggestIdColumn(["name", "ID"], "merchant")).toBe("ID");
    expect(suggestIdColumn(["name", "customer_id"], "user")).toBe("customer_id");
    expect(suggestIdColumn(["name", "country"], "user")).toBe("name");
  });
});

// The same cases as packages/sdk-python/tests/test_importer.py.
describe("a row as an event", () => {
  const mapping: EventImportMapping = {
    type: "transaction",
    ts: "created_at",
    id: "txn_id",
    entities: { user: "customer" },
  };
  const event = (values: Record<string, unknown>, m: EventImportMapping = mapping) =>
    eventFromRow({ line: 2, values }, m, sha256);

  it("maps a row to an event", () => {
    const values = {
      txn_id: "t1",
      created_at: "2026-10-01 10:00:00",
      customer: "c1",
      payee_id: "p9",
      amount: "95.50",
      count: "3",
      zip: "02139",
      card: "4242424242424242",
      flag: "TRUE",
      note: "",
      ref: "  abc ",
    };
    expect(event(values)).toEqual({
      ok: true,
      event: {
        id: "t1",
        type: "transaction",
        ts: "2026-10-01T10:00:00.000Z",
        entities: { user: "c1", payee: "p9" },
        properties: { amount: 95.5, count: 3, zip: "02139", card: "4242424242424242", flag: true, ref: "abc" },
      },
    });
  });

  it("reads each time format", () => {
    expect(importTime("2026-10-01")).toBe("2026-10-01T00:00:00.000Z");
    expect(importTime("2026-10-01T12:00:00+02:00")).toBe("2026-10-01T10:00:00.000Z");
    expect(importTime("2026-10-01T10:00:00Z")).toBe("2026-10-01T10:00:00.000Z");
    expect(importTime("2026-10-01T10:00:00.123456-0130")).toBe("2026-10-01T11:30:00.123Z");
    expect(importTime("1790000000", "unix")).toBe("2026-09-21T14:13:20.000Z");
    expect(importTime(1790000000123, "unix_ms")).toBe("2026-09-21T14:13:20.123Z");
    expect(importTime("01/10/2026 10:00", "%d/%m/%Y %H:%M")).toBe("2026-10-01T10:00:00.000Z");
    expect(importTime("1/3/2026 9:05 pm", "%d/%m/%Y %I:%M %p")).toBe("2026-03-01T21:05:00.000Z");
    expect(importTime("Mar 5 26", "%b %d %y")).toBe("2026-03-05T00:00:00.000Z");
    expect(importTime("2026-10-01Z")).toBe("2026-10-01T00:00:00.000Z");
    for (const [raw, format] of [
      ["2026-02-30", "iso"],
      ["yesterday", "iso"],
      ["0x10", "unix"],
      ["32/10/2026", "%d/%m/%Y"],
    ])
      expect(() => importTime(raw, format), `${raw} ${format}`).toThrow("is not a time");
  });

  it("gives a row with no id the same id each time, and the same id as the Python importer", () => {
    const m: EventImportMapping = { type: "login", ts: "ts" };
    const values = { ts: "2026-10-01T10:00:00Z", user_id: "u1" };
    const id = (v: Record<string, unknown>) => (event(v, m) as { event: { id: string } }).event.id;
    expect(id(values)).toBe(id({ ...values }));
    expect(id(values)).not.toBe(id({ ...values, user_id: "u2" }));
    expect(id(values)).toMatch(/^imp_[0-9a-f]{32}$/);
    // python3 -c 'import json,hashlib; print(hashlib.sha256(json.dumps(ROW, sort_keys=True, default=str).encode()).hexdigest()[:32])'
    expect(importRowId({ ts: "2026-10-01T10:00:00Z", user_id: "u1", name: 'Zoë "x"\n', n: null }, sha256)).toBe(
      "imp_baaf17c840e80ffc81defd2654685800",
    );
  });

  it("takes the type, records and sessions from columns", () => {
    const m: EventImportMapping = {
      typeColumn: "kind",
      ts: "ts",
      universalId: "ref",
      status: "state",
      session: "sid",
      exclude: ["secret"],
      text: ["code"],
    };
    const values = {
      kind: "payment",
      ts: "2026-10-01",
      user_id: "u",
      ref: "r1",
      state: "pending",
      sid: "s1",
      secret: "x",
      code: "12",
    };
    expect(event(values, m)).toMatchObject({
      event: { type: "payment", universal_id: "r1", status: "pending", session: "s1", properties: { code: "12" } },
    });
  });

  it("keeps values as they are when asked, and in JSON", () => {
    expect(event({ ts: "2026-10-01", user_id: "u", usd: "5" }, { type: "t", ts: "ts", typed: false })).toMatchObject({
      event: { properties: { usd: "5" } },
    });
    expect(
      event({ ts: "2026-10-01", user_id: "u", usd: "5", nested: { a: 1 }, n: 7 }, { type: "t", ts: "ts" }),
    ).toMatchObject({
      event: { properties: { usd: 5, nested: { a: 1 }, n: 7 } },
    });
  });

  it("includes only the columns asked for, and can ignore id columns", () => {
    const m: EventImportMapping = {
      type: "t",
      ts: "ts",
      include: ["usd"],
      autoEntities: false,
      entities: { user: "user_id" },
    };
    expect(event({ ts: "2026-10-01", user_id: "u", payee_id: "p", usd: "5", note: "x" }, m)).toMatchObject({
      event: { entities: { user: "u" }, properties: { usd: 5 } },
    });
  });

  it("refuses a row it cannot use, with the reason", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ txn_id: "t", created_at: "2026-10-01" }, "names no entity"],
      [{ txn_id: "t", customer: "c" }, "no time"],
      [{ txn_id: "t", customer: "c", created_at: "yesterday" }, '"yesterday" is not a time'],
      [{ customer: "c", created_at: "2026-10-01" }, "no id"],
      [{ txn_id: "x".repeat(300), customer: "c", created_at: "2026-10-01" }, "longer than 256"],
    ];
    for (const [values, reason] of cases) expect((event(values) as { reason: string }).reason).toContain(reason);
    expect(
      eventFromRow({ line: 2, values: {}, broken: "the row has more cells than the header" }, mapping, sha256),
    ).toEqual({
      ok: false,
      reason: "the row has more cells than the header",
    });
  });

  it("checks the mapping before reading a row", () => {
    const cases: [EventImportMapping, string][] = [
      [{ ts: "ts" }, "event type"],
      [{ type: "a", typeColumn: "b", ts: "ts" }, "event type"],
      [{ type: "t" }, "time of each event"],
      [{ type: "t", ts: "ts", entities: { "bad type": "c" } }, "not an entity type"],
      [{ type: "t", ts: "ts", tsFormat: "%d/%m/%Q" }, "%Q"],
    ];
    for (const [m, reason] of cases) expect(checkEventMapping(m)).toContain(reason);
    expect(checkEventMapping(mapping)).toBeUndefined();
  });
});

describe("a row as a label", () => {
  it("maps a label row", () => {
    const mapping = { entityType: "user", entity: "customer_id", label: "fraud_confirmed", ts: "reported" };
    expect(
      labelFromRow({ line: 2, values: { customer_id: "c1", reported: "2026-10-05", amount: "120" } }, mapping),
    ).toEqual({
      ok: true,
      label: {
        entity: { type: "user", id: "c1" },
        label: "fraud_confirmed",
        properties: { amount: 120 },
        ts: "2026-10-05T00:00:00.000Z",
      },
    });
    const byColumn = { entityType: "user", entity: "customer_id", labelColumn: "outcome" };
    expect(labelFromRow({ line: 2, values: { customer_id: "c1", outcome: "chargeback" } }, byColumn)).toMatchObject({
      label: { label: "chargeback" },
    });
    expect(labelFromRow({ line: 2, values: { customer_id: "c1", outcome: "two words" } }, byColumn)).toMatchObject({
      reason: '"two words" is not a label: use letters, digits and underscores, starting with a letter',
    });
    expect(checkLabelMapping({ entityType: "user", entity: "c" })).toContain("label");
  });
});
