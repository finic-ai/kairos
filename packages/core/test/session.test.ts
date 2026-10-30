import { describe, expect, it } from "vitest";
import {
  buildContext,
  evaluateTotals,
  summariseSession,
  totalsReach,
  validateTotals,
  type KairosEvent,
  type TotalDefinition,
} from "../src/index";

const NOW = Date.parse("2026-10-06T14:00:00Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString().slice(0, 19);
const ev = (minutesAgo: number, type: string, extra: Record<string, unknown> = {}): KairosEvent => ({
  ts: at(minutesAgo),
  type,
  ...extra,
});

describe("the session of a request", () => {
  it("says when the visit started, how long ago, and its steps in order", () => {
    const summary = summariseSession(
      [
        ev(2, "beneficiary_added"),
        ev(4, "login", { device: "d9" }),
        ev(3.5, "password_changed"),
        ev(1, "transfer", { status: "pending" }),
      ],
      NOW,
    )!;
    expect(summary.context).toEqual({
      started: at(4),
      started_before_this_action: "4 minutes",
      events: 4,
      steps: ["+0:00 login", "+0:30 password_changed", "+2:00 beneficiary_added", "+3:00 transfer (pending)"],
    });
    expect(summary.events.map((e) => e.type)).toEqual(["login", "password_changed", "beneficiary_added", "transfer"]);
  });

  it("ends a visit after thirty minutes with no event, and says when the same id was used before", () => {
    const summary = summariseSession(
      [ev(300, "login"), ev(299, "view_balance"), ev(5, "login"), ev(4, "withdrawal_requested")],
      NOW,
    )!;
    expect(summary.context).toMatchObject({
      started: at(5),
      events: 2,
      steps: ["+0:00 login", "+1:00 withdrawal_requested"],
      earlier_visits_with_this_session_id: true,
    });
    // The visit itself went quiet before the request.
    expect(summariseSession([ev(200, "login"), ev(190, "view_balance")], NOW)!.context).toMatchObject({
      events: 2,
      no_activity_before_this_action_for: "3 hours",
      started_before_this_action: "3 hours",
    });
  });

  it("says when other subjects used the same session, leaves out what comes after the request, and has nothing to say with no events", () => {
    expect(summariseSession([ev(3, "login")], NOW, { others: { noun: "users", count: 1 } })!.context).toMatchObject({
      other_users_in_this_session: 1,
    });
    expect(
      summariseSession([ev(3, "login")], NOW, { others: { noun: "users", count: 0 } })!.context,
    ).not.toHaveProperty("other_users_in_this_session");
    expect(summariseSession([ev(3, "login"), ev(-5, "logout")], NOW)!.context.events).toBe(1);
    expect(summariseSession([], NOW)).toBeNull();
    expect(summariseSession([ev(-5, "logout")], NOW)).toBeNull();
  });

  it("keeps the most recent forty steps of a long visit", () => {
    const many = Array.from({ length: 55 }, (_, i) => ev(55 - i, "page_view"));
    const { context } = summariseSession(many, NOW)!;
    expect((context.steps as string[]).length).toBe(40);
    expect(context).toMatchObject({ events: 55, earlier_steps_not_shown: 15 });
  });

  it("is in the context before the recent events, and only when there is one", () => {
    const input = { subject: { type: "user" }, events: [ev(3, "login")], pendingAction: { type: "withdrawal" } };
    expect(Object.keys(buildContext({ ...input, session: { events: 1 } }))).toEqual([
      "subject",
      "baseline_of_older_events",
      "this_session",
      "recent_events",
      "pending_action",
    ]);
    expect(buildContext(input)).not.toHaveProperty("this_session");
  });
});

describe("totals for the session", () => {
  const out: TotalDefinition = { name: "money_out", event: "transfer", sum: "usd", window: "session", covers: "usd" };
  const history = [ev(5000, "transfer", { usd: 70 }), ev(3, "transfer", { usd: 400 }), ev(2, "transfer", { usd: 100 })];

  it("adds up the events of the session, whatever its length", () => {
    const { context, values } = evaluateTotals([out], history, { usd: 1000 }, NOW, history.slice(1));
    expect(context).toEqual({
      money_out_this_session: { sum: 500, events: 2 },
      share_of_this_action_that_money_out_this_session_covers: 0.5,
    });
    expect(values.money_out).toEqual({ sum: 500, events: 2, share_covered: 0.5 });
  });

  it("is not calculated for a request with no session, so a rule on it cannot fire", () => {
    const { context, values } = evaluateTotals(
      [out, { name: "all_out", event: "transfer", sum: "usd" }],
      history,
      {},
      NOW,
    );
    expect(context).toEqual({ all_out_all_time: { sum: 570, events: 3 } });
    expect(values).not.toHaveProperty("money_out");
  });

  it("is a valid window that reads no history by time, and cannot be compared with a usual period", () => {
    expect(validateTotals([out])).toEqual([]);
    expect(totalsReach([out])).toBe(0);
    expect(totalsReach([out, { ...out, name: "week", window: "7d" }])).toBe(7 * 86_400_000);
    expect(validateTotals([{ ...out, covers: undefined, usual: "90d" }])[0]).toContain("session");
  });
});
