import { DEVICE_COOKIE, VISIT_COOKIE, readCookie } from "./cookies.js";

export interface Jar {
  cookies(): string;
  setCookie(cookie: string): void;
  storage?: Pick<Storage, "getItem" | "setItem">;
  secure: boolean;
  /** Such as `example.com`, so that its subdomains get the cookies. Without it, this host only. */
  domain?: string;
}

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const VISIT_IDLE_MS = 30 * 60 * 1000;
const VISIT_AT = "kairos_visit_at";

export function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function setCookie(jar: Jar, name: string, value: string, lifetime: string): void {
  const domain = jar.domain ? `; Domain=${jar.domain}` : "";
  jar.setCookie(`${name}=${value}${lifetime}; Path=/${domain}; SameSite=Lax${jar.secure ? "; Secure" : ""}`);
}

export function deviceId(jar: Jar): string {
  const id = readCookie(jar.cookies(), DEVICE_COOKIE) || jar.storage?.getItem(DEVICE_COOKIE) || randomId();
  setCookie(jar, DEVICE_COOKIE, id, `; Max-Age=${YEAR_SECONDS}`);
  jar.storage?.setItem(DEVICE_COOKIE, id);
  return id;
}

export function visitId(jar: Jar, now = Date.now()): string {
  const last = Number(jar.storage?.getItem(VISIT_AT));
  const current = readCookie(jar.cookies(), VISIT_COOKIE);
  const id = current && !(last && now - last > VISIT_IDLE_MS) ? current : randomId();
  setCookie(jar, VISIT_COOKIE, id, "");
  jar.storage?.setItem(VISIT_AT, String(now));
  return id;
}
