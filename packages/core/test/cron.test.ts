import { describe, expect, it } from "vitest";
import { cronMatches, cronProblem, isTimeZone, lastDue, nextDue, parseCron } from "../src/cron";

const at = (iso: string) => new Date(iso);

describe("cron", () => {
  it("reads numbers, ranges, steps, lists and names", () => {
    const cron = parseCron("*/15 9-17 * JAN,jul MON-FRI");
    expect([...cron.minute]).toEqual([0, 15, 30, 45]);
    expect([...cron.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...cron.month]).toEqual([1, 7]);
    expect([...cron.weekday]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("0 0 * * 7").weekday]).toEqual([0]);
    expect([...parseCron("5/20 * * * *").minute]).toEqual([5, 25, 45]);
  });

  it("says what is wrong", () => {
    expect(cronProblem("0 9 * *")).toMatch(/five fields/);
    expect(cronProblem("60 9 * * *")).toMatch(/minute: "60" is not from 0 to 59/);
    expect(cronProblem("0 9 * * 1-")).toMatch(/day of week/);
    expect(cronProblem("*/0 * * * *")).toMatch(/step/);
    expect(cronProblem("0 9 * * MON")).toBeNull();
  });

  it("matches in a time zone, and a day by its day of month or its day of week", () => {
    const daily = parseCron("0 9 * * *");
    expect(cronMatches(daily, at("2026-10-27T09:00:30Z"))).toBe(true);
    expect(cronMatches(daily, at("2026-10-27T09:00:00Z"), "America/Los_Angeles")).toBe(false);
    expect(cronMatches(daily, at("2026-10-27T16:00:00Z"), "America/Los_Angeles")).toBe(true);
    // The 1st of the month, or a Monday: 2026-11-02 is a Monday.
    const either = parseCron("0 0 1 * MON");
    expect(cronMatches(either, at("2026-11-01T00:00:00Z"))).toBe(true);
    expect(cronMatches(either, at("2026-11-02T00:00:00Z"))).toBe(true);
    expect(cronMatches(either, at("2026-11-03T00:00:00Z"))).toBe(false);
    expect(isTimeZone("Europe/London")).toBe(true);
    expect(isTimeZone("Mars/Base")).toBe(false);
  });

  it("finds the last due minute, and the next ones", () => {
    const hourly = parseCron("30 * * * *");
    expect(lastDue(hourly, at("2026-10-27T00:00:00Z"), at("2026-10-27T10:45:10Z"))).toEqual(at("2026-10-27T10:30:00Z"));
    // Nothing due after `after`: a time before it is not run.
    expect(lastDue(hourly, at("2026-10-27T10:31:00Z"), at("2026-10-27T10:45:00Z"))).toBeNull();
    expect(nextDue(parseCron("0 9 * * *"), at("2026-10-27T09:00:00Z"), 2)).toEqual([
      at("2026-10-28T09:00:00Z"),
      at("2026-10-29T09:00:00Z"),
    ]);
  });
});
