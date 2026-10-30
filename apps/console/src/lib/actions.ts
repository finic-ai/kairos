import type { ActionDefinition, PolicyRule, TotalCondition, TotalDefinition } from "../types/interfaces";
import type { Pair } from "../components/ui/Pairs";
import { actionName, entityName } from "./format";

export interface Draft {
  label: string;
  /** The key: what the code passes to decide(). */
  name: string;
  description: string;
  subject: string;
  trigger: string;
  /** Statuses that start the action, separated by commas. Empty means every status. */
  triggerStatus: string;
  automatic: boolean;
  hold: string;
  typologies: Pair[];
  reasons: Pair[];
  block: number;
  review: number;
  rules: PolicyRule[];
}

export const BLANK: Draft = {
  label: "",
  name: "",
  description: "",
  subject: "user",
  trigger: "",
  triggerStatus: "",
  automatic: false,
  hold: "",
  typologies: [],
  reasons: [],
  block: 0.9,
  review: 0.5,
  rules: [],
};

export const toDraft = (a: ActionDefinition): Draft => ({
  label: actionName(a),
  name: a.name,
  description: a.description ?? "",
  subject: a.subject,
  trigger: typeof a.trigger === "string" ? a.trigger : (a.trigger?.event ?? ""),
  triggerStatus: typeof a.trigger === "object" ? [a.trigger.status ?? []].flat().join(", ") : "",
  automatic: !!a.automatic,
  hold: a.hold,
  typologies: Object.entries(a.typologies ?? {}),
  reasons: Object.entries(a.reasons ?? {}),
  block: a.policy?.block ?? 0.9,
  review: a.policy?.review ?? 0.5,
  rules: a.policy?.rules ?? [],
});

export const statuses = (d: Draft) =>
  d.triggerStatus
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function toDefinition(d: Draft, base?: ActionDefinition): ActionDefinition {
  const pairs = (list: Pair[]) =>
    list.length ? Object.fromEntries(list.map(([code, text]) => [code.trim(), text.trim()])) : undefined;
  return {
    name: d.name.trim(),
    ...(d.label.trim() && d.label.trim() !== entityName(d.name.trim()) ? { displayName: d.label.trim() } : {}),
    ...(d.description.trim() ? { description: d.description.trim() } : {}),
    subject: d.subject.trim(),
    ...(d.trigger.trim()
      ? { trigger: statuses(d).length ? { event: d.trigger.trim(), status: statuses(d) } : d.trigger.trim() }
      : {}),
    ...(d.trigger.trim() && d.automatic ? { automatic: true } : {}),
    hold: d.hold.trim(),
    ...(pairs(d.typologies) ? { typologies: pairs(d.typologies) } : {}),
    ...(pairs(d.reasons) ? { reasons: pairs(d.reasons) } : {}),
    policy: {
      block: d.block,
      review: d.review,
      rules: d.rules.map(({ when, ...rule }) => ({ ...rule, ...(when?.length ? { when } : {}) })),
    },
    ...(base?.context ? { context: base.context } : {}),
  };
}

export const camel = (type: string) => type.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

export function snippet(a: ActionDefinition): string {
  const subject = `${camel(a.subject)}Id: "${a.subject}_42"`;
  if (!a.trigger)
    return `const decision = await kairos.decide({\n  type: "${a.name}",\n  ${subject},\n  // what is being asked for\n  amount: 500,\n});\n\nif (decision.decision === "block") {\n  // stop it\n}`;
  const event = typeof a.trigger === "string" ? a.trigger : a.trigger.event;
  const status = typeof a.trigger === "object" ? [a.trigger.status ?? []].flat()[0] : undefined;
  return `const decision = await kairos.trackAndDecide("${event}", {\n  ${subject},${status ? `\n  status: "${status}",` : ""}\n  amount: 500,\n});\n\nif (decision.decision === "block") {\n  // stop it\n}`;
}

export const WINDOWS: [string, string][] = [
  ["30m", "30 minutes"],
  ["1h", "1 hour"],
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
  ["session", "This session"],
];

export const USUAL: [string, string, number][] = [
  ["24h", "24 hours", 1],
  ["7d", "7 days", 7],
  ["30d", "30 days", 30],
  ["90d", "90 days", 90],
  ["180d", "180 days", 180],
  ["365d", "a year", 365],
];

export const windowDays = (window: string | undefined) => {
  const match = /^(\d+)([mhd])$/.exec(window ?? "");
  return match ? Number(match[1]) * { m: 1 / 1440, h: 1 / 24, d: 1 }[match[2] as "m" | "h" | "d"] : 0;
};

export const withCurrent = (options: [string, string][], value: string | undefined): [string, string][] =>
  value && !options.some(([id]) => id === value) ? [...options, [value, value]] : options;

export function cleanTotal(t: TotalDefinition): TotalDefinition {
  const where = Object.fromEntries(
    Object.entries(t.where ?? {})
      .map(
        ([key, value]) =>
          [
            key.trim(),
            [value]
              .flat()
              .map((v) => String(v).trim())
              .filter(Boolean),
          ] as const,
      )
      .filter(([key, values]) => key && values.length)
      .map(([key, values]) => [key, values.length === 1 ? values[0]! : values]),
  );
  return {
    name: t.name.trim(),
    event: t.event.trim(),
    sum: t.sum.trim(),
    ...(Object.keys(where).length ? { where } : {}),
    ...(t.window ? { window: t.window } : {}),
    ...(t.window && t.usual ? { usual: t.usual } : {}),
    ...(t.covers?.trim() && !t.by ? { covers: t.covers.trim() } : {}),
    ...(t.by ? { by: t.by } : {}),
  };
}

export const MEASURES: Record<NonNullable<TotalCondition["is"]>, string> = {
  sum: "sum",
  events: "number of events",
  times_usual: "times the usual",
  share_covered: "share of the request it covers",
};

export const conditionText = (c: TotalCondition) =>
  `${c.total} ${MEASURES[c.is ?? "sum"]} ${c.op.replace(">=", "≥").replace("<=", "≤")} ${Number(c.value).toLocaleString()}`;

export function totalSentence(t: TotalDefinition): string {
  const where = Object.entries(t.where ?? {}).map(([key, value]) => `${key} is ${[value].flat().join(" or ")}`);
  return [
    `The sum of ${t.sum} in ${t.event} events${where.length ? ` where ${where.join(" and ")}` : ""}, ${t.window === "session" ? "in the session of the request" : t.window ? `in the last ${t.window}` : "in all history"}.`,
    t.usual && `Compared with a usual ${t.window} over ${t.usual}.`,
    t.covers && `Says what share of the action's ${t.covers} it covers.`,
    t.by && `Split by ${t.by}.`,
  ]
    .filter(Boolean)
    .join(" ");
}
