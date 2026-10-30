import type { ActionDefinition } from "../types/interfaces";

const UPPER = new Set(["ip", "atm", "id", "kyc", "url", "api", "sms", "pos", "iban", "ssn", "vpn"]);

export const entityName = (type: string) =>
  type
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => (UPPER.has(word.toLowerCase()) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");

export const actionName = (action: { name: string; displayName?: string }) =>
  action.displayName?.trim() || entityName(action.name);

export const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "_$1")
    .slice(0, 64);

export const entityNames = (type: string) => {
  const name = entityName(type);
  if (/^[A-Z]+$/.test(name.split(" ").pop()!)) return `${name}s`; // IPs, ATMs
  return /[^aeiou]y$/.test(name) ? `${name.slice(0, -1)}ies` : /(s|x|z|ch|sh)$/.test(name) ? `${name}es` : `${name}s`;
};

const parse = (ts: string) => new Date(/Z|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts.length === 16 ? `${ts}:00` : ts}Z`);
export const dayOf = (ts: string) =>
  parse(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const timeOf = (ts: string) =>
  parse(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
export const stamp = (ts: string) =>
  `${parse(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}, ${timeOf(ts)}`;

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d/;
/** A date and time, or the text as it is when it only starts like one ("2026-10-03T21:00Z to 22:00Z"). */
const moment = (value: string) => (Number.isNaN(parse(value).getTime()) ? value : `${dayOf(value)}, ${timeOf(value)}`);
const DATA_ADDRESS = /^data:([a-z]+\/[a-z0-9.+-]+)?[^,]*?(;base64)?,/i;
const FILE_KIND: Record<string, string> = { "application/pdf": "PDF document", "text/plain": "Text file" };

export function dataAddressText(value: string): string | null {
  const match = DATA_ADDRESS.exec(value);
  if (!match) return null;
  const type = (match[1] ?? "application/octet-stream").toLowerCase();
  const content = value.length - match[0].length;
  const bytes = match[2] ? Math.floor((content * 3) / 4) : content;
  const size =
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const kind = type.startsWith("image/")
    ? `${type.slice(6).split("+")[0]!.toUpperCase()} image`
    : (FILE_KIND[type] ?? type);
  return `${kind} · ${size}`;
}

export const valueText = (value: unknown): string =>
  typeof value === "string" && value.startsWith("data:") && dataAddressText(value)
    ? dataAddressText(value)!
    : typeof value === "string" && ISO.test(value)
      ? moment(value)
      : typeof value === "number"
        ? value.toLocaleString("en-US", { maximumFractionDigits: 4 })
        : Array.isArray(value)
          ? value.map(valueText).join(", ")
          : typeof value === "object" && value !== null
            ? Object.entries(value)
                .map(([k, v]) => `${k.replaceAll("_", " ")}: ${valueText(v)}`)
                .join(", ")
            : String(value);

export function triggerText(trigger: ActionDefinition["trigger"]): string {
  if (!trigger) return "";
  if (typeof trigger === "string") return trigger;
  const list = [trigger.status ?? []].flat();
  return list.length ? `${trigger.event} when ${list.join(" or ")}` : trigger.event;
}

export const previewValue = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}
