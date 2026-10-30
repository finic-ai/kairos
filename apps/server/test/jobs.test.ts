import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { JobsService } from "../src/services/job.service";
import { createJobs, PermanentError, type JobKind, type JobRun } from "../src/platform/jobs/worker";
import { testDatabase } from "./helpers/database";

const database = await testDatabase();
const repo = new JobsService(database.db);
const START = new Date("2026-10-25T10:00:00Z");
let clock: Date;
const later = (ms: number) => (clock = new Date(clock.getTime() + ms));

beforeEach(async () => {
  await database.reset();
  clock = START;
});

/** A kind that records its runs, and fails while `failing` says so. */
function recorder(overrides: Partial<JobKind> = {}) {
  const runs: { payload: Record<string, unknown>; job: JobRun }[] = [];
  let failing: Error | null = null;
  const kind: JobKind = {
    kind: "test",
    concurrency: 10,
    retryDelaysMs: [1_000, 60_000],
    async run(payload, job) {
      runs.push({ payload, job });
      if (failing) throw failing;
    },
    ...overrides,
  };
  return { kind, runs, fail: (error: Error | null) => (failing = error) };
}

const worker = (kinds: JobKind[], extra: Partial<Parameters<typeof createJobs>[0]> = {}) =>
  createJobs({ repo, kinds, now: () => clock, random: () => 0.5, log: () => {}, ...extra });

const status = async (key: string, kind = "test") => (await repo.findByKey(kind, key))!;

describe("running jobs", () => {
  it("runs a due job once, and a second enqueue of the same work does nothing", async () => {
    const { kind, runs } = recorder();
    expect(await repo.enqueue({ kind: "test", key: "a", payload: { n: 1 } }, clock)).toBe(true);
    expect(await repo.enqueue({ kind: "test", key: "a", payload: { n: 2 } }, clock)).toBe(false);
    expect(await worker([kind]).drain()).toBe(1);
    expect(runs.map((r) => r.payload)).toEqual([{ n: 1 }]);
    expect(await status("a")).toMatchObject({ status: "done", attempts: 1 });
    expect(await worker([kind]).drain()).toBe(0);
  });

  it("does not run a job before its time", async () => {
    const { kind, runs } = recorder();
    await repo.enqueue({ kind: "test", key: "a", payload: {}, runAt: new Date(START.getTime() + 60_000) }, clock);
    await worker([kind]).drain();
    expect(runs).toHaveLength(0);
    later(60_000);
    await worker([kind]).drain();
    expect(runs).toHaveLength(1);
  });

  it("retries on the policy of its kind, then keeps the job as dead with its error", async () => {
    const { kind, runs, fail } = recorder();
    fail(new Error("the receiver is down"));
    await repo.enqueue({ kind: "test", key: "a", payload: {} }, clock);
    const jobs = worker([kind]);
    await jobs.drain();
    expect(runs[0]!.job.retryAt).toEqual(new Date(START.getTime() + 1_000));
    expect(await status("a")).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "the receiver is down",
      run_at: new Date(START.getTime() + 1_000).toISOString(),
    });
    later(1_000);
    await jobs.drain();
    expect(await status("a")).toMatchObject({ status: "pending", attempts: 2 });
    later(60_000);
    await jobs.drain();
    expect(runs[2]!.job.retryAt).toBeUndefined();
    expect(await status("a")).toMatchObject({ status: "dead", attempts: 3, last_error: "the receiver is down" });
  });

  it("stops at once on a permanent error", async () => {
    const { kind, fail } = recorder();
    fail(new PermanentError("the endpoint is gone"));
    await repo.enqueue({ kind: "test", key: "a", payload: {} }, clock);
    await worker([kind]).drain();
    expect(await status("a")).toMatchObject({ status: "dead", attempts: 1, last_error: "the endpoint is gone" });
  });

  it("claims a job for a lease, and claims it again when a stopped process leaves it", async () => {
    await repo.enqueue({ kind: "test", key: "a", payload: {} }, clock);
    expect(await repo.claim("test", clock, 10, 120_000)).toHaveLength(1);
    // The process stops here, with the job claimed and not finished.
    later(60_000);
    expect(await repo.claim("test", clock, 10, 120_000)).toHaveLength(0);
    later(60_000);
    const { kind, runs } = recorder();
    await worker([kind]).drain();
    expect(runs.map((r) => r.job.attempts)).toEqual([2]);
  });

  it("runs each job once when two workers drain at the same time", async () => {
    const { kind, runs } = recorder();
    for (let i = 0; i < 20; i++) await repo.enqueue({ kind: "test", key: `j${i}`, payload: { i } }, clock);
    await Promise.all([worker([kind]).drain(), worker([kind]).drain()]);
    expect(runs).toHaveLength(20);
    expect(new Set(runs.map((r) => r.payload.i)).size).toBe(20);
  });

  it("runs at most `perGroup` jobs of one group at once, and other groups beside them", async () => {
    let active = 0;
    let most = 0;
    const kind: JobKind = {
      kind: "test",
      concurrency: 10,
      perGroup: 1,
      retryDelaysMs: [],
      async run(payload) {
        if (payload.group !== "slow") return;
        most = Math.max(most, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
      },
    };
    for (let i = 0; i < 3; i++)
      await repo.enqueue({ kind: "test", key: `slow${i}`, payload: { group: "slow" }, group: "slow" }, clock);
    await repo.enqueue({ kind: "test", key: "other", payload: {}, group: "other" }, clock);
    expect(await worker([kind]).drain()).toBe(4);
    expect(most).toBe(1);
  });

  it("does not start a batch that would end after its deadline", async () => {
    const { kind } = recorder({ timeoutMs: 10_000 });
    await repo.enqueue({ kind: "test", key: "a", payload: {} }, clock);
    expect(await worker([kind]).drain({ budgetMs: 1 })).toBe(0);
    expect(await worker([kind]).drain({ budgetMs: 60_000 })).toBe(1);
  });
});

describe("groups, transactions and schedules", () => {
  it("pauses the jobs of a group, and starts them again", async () => {
    const { kind, runs } = recorder();
    await repo.enqueue({ kind: "test", key: "a", payload: {}, group: "wh_1" }, clock);
    await repo.pauseGroup("wh_1", clock);
    await worker([kind]).drain();
    expect(runs).toHaveLength(0);
    expect(await status("a")).toMatchObject({ status: "paused" });
    later(1_000);
    await repo.resumeGroup("wh_1", clock);
    await worker([kind]).drain();
    expect(runs).toHaveLength(1);
  });

  it("writes a job only with the change that needs it", async () => {
    await expect(
      database.db.transaction(async (tx) => {
        expect(await new JobsService(tx).enqueue({ kind: "test", key: "a", payload: {} }, clock)).toBe(true);
        throw new Error("the change was not saved");
      }),
    ).rejects.toThrow();
    expect(await repo.findByKey("test", "a")).toBeNull();
  });

  it("starts a job again from no attempts", async () => {
    const { kind, fail } = recorder({ retryDelaysMs: [] });
    fail(new Error("no"));
    await repo.enqueue({ kind: "test", key: "a", payload: {} }, clock);
    await worker([kind]).drain();
    expect(await status("a")).toMatchObject({ status: "dead" });
    await repo.requeue({ kind: "test", key: "a", payload: {} }, clock);
    expect(await status("a")).toMatchObject({ status: "pending", attempts: 0, last_error: null });
  });

  it("makes one scheduled job for each period, whatever the number of workers", async () => {
    const { kind, runs } = recorder({ kind: "hourly" });
    const schedules = [{ kind: "hourly", everyMs: 3_600_000 }];
    await Promise.all([worker([kind], { schedules }).drain(), worker([kind], { schedules }).drain()]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.job.key).toBe("hourly:2026-10-25T10:00:00.000Z");
    later(30 * 60_000);
    await worker([kind], { schedules }).drain();
    expect(runs).toHaveLength(1);
    later(30 * 60_000);
    await worker([kind], { schedules }).drain();
    expect(runs).toHaveLength(2);
  });

  it("deletes finished jobs after their time, and keeps the others", async () => {
    const { kind, fail } = recorder({ retryDelaysMs: [] });
    await repo.enqueue({ kind: "test", key: "done", payload: {} }, clock);
    await worker([kind]).drain();
    fail(new Error("no"));
    await repo.enqueue({ kind: "test", key: "dead", payload: {} }, clock);
    await worker([kind]).drain();
    await repo.enqueue(
      { kind: "test", key: "pending", payload: {}, runAt: new Date(START.getTime() + 365 * 86_400_000) },
      clock,
    );
    expect(await repo.cleanup(new Date(START.getTime() + 8 * 86_400_000), 7, 30)).toBe(1);
    expect(await repo.cleanup(new Date(START.getTime() + 31 * 86_400_000), 7, 30)).toBe(1);
    const left = await database.db.execute<Record<string, any>>(sql`SELECT key FROM jobs`);
    expect(left.rows).toEqual([{ key: "pending" }]);
  });
});

describe("the operations on many jobs", () => {
  const job = (key: string, group?: string) => ({ kind: "test", key, payload: {}, ...(group ? { group } : {}) });

  it("writes many jobs once, and starts many again from no attempts", async () => {
    await repo.enqueueMany([job("a"), job("b")], clock);
    await repo.enqueueMany([job("a"), job("c")], clock);
    expect(
      (await database.db.execute<{ key: string }>(sql`SELECT key FROM jobs ORDER BY key`)).rows.map((r) => r.key),
    ).toEqual(["a", "b", "c"]);
    await database.db.execute(sql`UPDATE jobs SET status = 'dead', attempts = 3 WHERE key = 'a'`);
    await repo.requeueMany([job("a")], clock);
    expect(await status("a")).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("cancels the pending jobs whose key starts with the prefix, as text", async () => {
    // In LIKE, "_" stands for any character: "wfr_1:" would also find "wfrx1:".
    await repo.enqueueMany([job("wfr_1:1"), job("wfr_1:2"), job("wfrx1:1"), job("wfr_10:1")], clock);
    await database.db.execute(sql`UPDATE jobs SET status = 'done' WHERE key = 'wfr_1:2'`);
    expect(await repo.cancelPending("test", "wfr_1:")).toBe(1);
    expect(
      (await database.db.execute<{ key: string }>(sql`SELECT key FROM jobs ORDER BY key`)).rows.map((r) => r.key),
    ).toEqual(["wfr_10:1", "wfr_1:2", "wfrx1:1"]);
  });

  it("deletes a group's jobs that have not run", async () => {
    await repo.enqueueMany([job("x", "hook_1"), job("y", "hook_1"), job("z", "hook_2")], clock);
    await repo.pauseGroup("hook_1", clock);
    await repo.deleteGroup("hook_1");
    expect((await database.db.execute<{ key: string }>(sql`SELECT key FROM jobs`)).rows.map((r) => r.key)).toEqual([
      "z",
    ]);
  });
});
