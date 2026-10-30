/**
 * Cron schedules: five fields (minute, hour, day of month, month, day of week) in a time zone.
 * Each field is `*`, a number, a range `a-b`, a step `*\/s` or `a-b/s`, or a list of them; months
 * and days can be names (JAN, MON). As in cron, when both the day of month and the day of week
 * are set, a day that matches either one is due. The server starts scheduled workflows with it,
 * and the console shows the next times with the same code.
 */

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  day: Set<number>;
  month: Set<number>;
  weekday: Set<number>;
  /** `*` in the day of month or the day of week: that field does not limit the day. */
  anyDay: boolean;
  anyWeekday: boolean;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const FIELDS: { name: string; min: number; max: number; names?: string[]; offset?: number }[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, offset: 1 },
  // 7 is Sunday too, as in most crons.
  { name: "day of week", min: 0, max: 7, names: DAYS, offset: 0 },
];

function field(text: string, spec: (typeof FIELDS)[number]): Set<number> {
  const value = (part: string) => {
    const named = spec.names?.indexOf(part.toUpperCase()) ?? -1;
    const n = named >= 0 ? named + (spec.offset ?? 0) : /^\d+$/.test(part) ? Number(part) : Number.NaN;
    if (!Number.isInteger(n) || n < spec.min || n > spec.max)
      throw new Error(`${spec.name}: "${part}" is not from ${spec.min} to ${spec.max}`);
    return n;
  };
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const [range, stepText] = item.split("/") as [string, string | undefined];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1)
      throw new Error(`${spec.name}: "${item}" has a step that is not a whole number above 0`);
    let from: number;
    let to: number;
    if (range === "*") [from, to] = [spec.min, spec.max];
    else if (range.includes("-")) {
      const [a, b] = range.split("-") as [string, string];
      [from, to] = [value(a), value(b)];
      if (from > to) throw new Error(`${spec.name}: "${range}" goes backwards`);
    } else {
      from = value(range);
      to = stepText === undefined ? from : spec.max;
    }
    for (let n = from; n <= to; n += step) out.add(spec.name === "day of week" && n === 7 ? 0 : n);
  }
  return out;
}

/** It throws with what is wrong in it. */
export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("a cron has five fields: minute, hour, day of month, month and day of week");
  const [minute, hour, day, month, weekday] = parts.map((p, i) => field(p, FIELDS[i]!));
  return {
    minute: minute!,
    hour: hour!,
    day: day!,
    month: month!,
    weekday: weekday!,
    anyDay: parts[2] === "*",
    anyWeekday: parts[4] === "*",
  };
}

export function cronProblem(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (cause) {
    return (cause as Error).message;
  }
}

/** Whether a time zone is one that the runtime knows, such as "Europe/London". */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();
function partsIn(date: Date, zone: string) {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formats.set(zone, format);
  }
  const parts = format.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    day: Number(get("day")),
    month: Number(get("month")),
    weekday: DAYS.indexOf(get("weekday").toUpperCase()),
  };
}

/** Whether the minute that `date` falls in is due, in the time zone. */
export function cronMatches(cron: Cron, date: Date, zone = "UTC"): boolean {
  const p = partsIn(date, zone);
  if (!cron.minute.has(p.minute) || !cron.hour.has(p.hour) || !cron.month.has(p.month)) return false;
  const byDay = cron.day.has(p.day);
  const byWeekday = cron.weekday.has(p.weekday);
  if (cron.anyDay && cron.anyWeekday) return true;
  if (cron.anyDay) return byWeekday;
  if (cron.anyWeekday) return byDay;
  return byDay || byWeekday;
}

const MINUTE = 60_000;
const startOfMinute = (date: Date) => new Date(Math.floor(date.getTime() / MINUTE) * MINUTE);

/** The latest due minute after `after` and at or before `until`, or null. Looks back at most a day. */
export function lastDue(cron: Cron, after: Date, until: Date, zone = "UTC"): Date | null {
  const floor = Math.max(after.getTime(), until.getTime() - 1440 * MINUTE);
  for (let t = startOfMinute(until).getTime(); t > floor; t -= MINUTE)
    if (cronMatches(cron, new Date(t), zone)) return new Date(t);
  return null;
}

/** The next `count` due minutes after `from`. Looks ahead at most a year. */
export function nextDue(cron: Cron, from: Date, count: number, zone = "UTC"): Date[] {
  const out: Date[] = [];
  const end = from.getTime() + 366 * 1440 * MINUTE;
  for (let t = startOfMinute(from).getTime() + MINUTE; t <= end && out.length < count; t += MINUTE)
    if (cronMatches(cron, new Date(t), zone)) out.push(new Date(t));
  return out;
}
