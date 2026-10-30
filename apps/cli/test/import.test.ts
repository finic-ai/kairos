import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "../src/client";
import { importHistory } from "../src/commands/import";
import type { Context } from "../src/context";

/** A fake Kairos: stores event ids once, as the real one does, and refuses a batch with the id "t7". */
let server: Server;
let url = "";
const calls: { path: string; size: number }[] = [];
const stored = new Set<string>();

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const batch = (JSON.parse(body) as { batch: { id?: string }[] }).batch;
      calls.push({ path: req.url!, size: batch.length });
      res.setHeader("Content-Type", "application/json");
      if (req.headers.authorization === "Bearer ksk_no_workspace") {
        res.statusCode = 400;
        return res.end(
          JSON.stringify({ error: { type: "invalid_request", message: "X-Kairos-Workspace: choose a workspace" } }),
        );
      }
      if (batch.some((item) => item.id === "t7")) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { type: "invalid_request", message: "batch.0: refused by the test" } }));
      }
      const fresh = batch.filter((item) => !item.id || !stored.has(item.id));
      for (const item of fresh) if (item.id) stored.add(item.id);
      res.end(JSON.stringify({ accepted: fresh.length, duplicates: batch.length - fresh.length }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const ctx = (json = true): Context => ({
  json,
  profile: "test",
  stored: () => ({}),
  client: () => new Client({ url, apiKey: "ksk_test" }),
});

async function capture(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await run();
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
  return lines.join("\n");
}

describe("kairos import", () => {
  const dir = mkdtempSync(join(tmpdir(), "kairos-import-"));
  const file = join(dir, "tx.csv");
  const rows = Array.from({ length: 20 }, (_, i) => `t${i},2026-10-01T10:00:00Z,u${i},${i}`);
  writeFileSync(file, `txn_id,ts,user_id,usd\n${rows.join("\n")}\nbad,never,u1,1\n`);
  const args = ["events", file, "--type", "transaction", "--ts", "ts", "--id", "txn_id", "--batch-size", "8"];

  it("sends batches, finds the row the server refuses, and writes the rejects with the reason", async () => {
    const out = JSON.parse(await capture(() => importHistory(args, ctx())));
    expect(out).toMatchObject({ read: 21, stored: 20 - 1, duplicates: 0, rejected: 2 });
    expect(stored.has("t7")).toBe(false);
    const rejects = readFileSync(`${file}.rejects.jsonl`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rejects.map((r) => [r.line, r.reason])).toEqual([
      [9, "the server refused it: batch.0: refused by the test"],
      [22, '"never" is not a time'],
    ]);
  });

  it("stores nothing twice when it is run again", async () => {
    const out = JSON.parse(await capture(() => importHistory(args, ctx())));
    expect(out).toMatchObject({ stored: 0, duplicates: 19, rejected: 2 });
  });

  it("sends nothing on a dry run, and stops at the limit", async () => {
    const before = calls.length;
    const out = JSON.parse(await capture(() => importHistory([...args, "--dry-run", "--limit", "3"], ctx())));
    expect(out).toMatchObject({ read: 3, stored: 0, dry_run: true });
    expect(out.sample.map((e: { id: string }) => e.id)).toEqual(["t0", "t1", "t2"]);
    expect(calls.length).toBe(before);
  });

  it("sends entities and labels to their endpoints, and leaves no rejects file when nothing is rejected", async () => {
    const customers = join(dir, "c.csv");
    writeFileSync(customers, "customer_id,plan\nc1,pro\n");
    await capture(() => importHistory(["entities", customers, "--type", "user"], ctx()));
    await capture(() =>
      importHistory(["labels", customers, "--entity", "user=customer_id", "--label", "chargeback"], ctx()),
    );
    expect(calls.slice(-2).map((c) => c.path)).toEqual(["/v1/objects", "/v1/labels"]);
    expect(existsSync(`${customers}.rejects.jsonl`)).toBe(false);
  });

  it("stops at once when the server refuses the request and not a row of it", async () => {
    const before = calls.length;
    const refused: Context = { ...ctx(), client: () => new Client({ url, apiKey: "ksk_no_workspace" }) };
    await expect(capture(() => importHistory(args, refused))).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining("choose a workspace"),
    });
    expect(calls.length - before).toBe(1);
  });

  it("refuses a wrong command with exit code 2", async () => {
    await expect(importHistory(["events", file, "--ts", "ts"], ctx())).rejects.toMatchObject({ exitCode: 2 });
    await expect(
      importHistory(["events", join(dir, "missing.csv"), "--type", "t", "--ts", "ts"], ctx()),
    ).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining("No file"),
    });
  });
});
