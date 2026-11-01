import { describe, expect, it } from "vitest";
import { automation, deviceId, hash, readCookie, visitId, type Jar } from "../src/index.js";

function jar(cookie = "", options: Partial<Jar> = {}) {
  const cookies = new Map<string, string>();
  for (const part of cookie.split("; ").filter(Boolean)) cookies.set(part.split("=")[0]!, part.split("=")[1]!);
  const set: string[] = [];
  const stored = new Map<string, string>();
  const page: Jar = {
    cookies: () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    setCookie: (value) => {
      set.push(value);
      const [pair] = value.split(";");
      cookies.set(pair!.split("=")[0]!, pair!.split("=")[1]!);
    },
    storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value) },
    secure: true,
    ...options,
  };
  return { page, set, stored };
}

describe("kairosid", () => {
  it("hashes a text to 16 hex digits, the same each time, and differently for another text", () => {
    expect(hash("a browser")).toMatch(/^[0-9a-f]{16}$/);
    expect(hash("a browser")).toBe(hash("a browser"));
    expect(hash("a browser")).not.toBe(hash("a browser."));
    expect(new Set(Array.from({ length: 2000 }, (_, i) => hash(`part ${i}`))).size).toBe(2000);
  });

  it("reads one cookie of a header", () => {
    expect(readCookie("theme=dark; kairos_device=d%201; x=1", "kairos_device")).toBe("d 1");
    expect(readCookie("kairos_device_old=1", "kairos_device")).toBeUndefined();
    expect(readCookie(undefined, "kairos_device")).toBeUndefined();
  });

  it("keeps the device in a cookie for a year, and brings it back from storage when the cookie is cleared", () => {
    const first = jar("", { domain: "example.com" });
    const id = deviceId(first.page);
    expect(first.set[0]).toBe(
      `kairos_device=${id}; Max-Age=31536000; Path=/; Domain=example.com; SameSite=Lax; Secure`,
    );
    expect(deviceId(first.page)).toBe(id);

    const cleared = jar("", { storage: first.page.storage, secure: false });
    expect(deviceId(cleared.page)).toBe(id);
    expect(cleared.set[0]).toBe(`kairos_device=${id}; Max-Age=31536000; Path=/; SameSite=Lax`);
  });

  it("keeps a visit for 30 minutes after its last activity, in a cookie of the browser session", () => {
    const { page, set } = jar();
    const start = Date.parse("2026-10-31T10:00:00Z");
    const minute = 60_000;
    const first = visitId(page, start);
    expect(set[0]).toBe(`kairos_visit=${first}; Path=/; SameSite=Lax; Secure`);
    expect(visitId(page, start + 29 * minute)).toBe(first);
    expect(visitId(page, start + 58 * minute)).toBe(first);
    expect(visitId(page, start + 89 * minute)).not.toBe(first);
  });

  it("says when a tool drives the browser", () => {
    expect(automation({ webdriver: true, userAgent: "Mozilla/5.0 Chrome/141" })).toEqual({
      webdriver: true,
      headless: false,
    });
    expect(automation({ webdriver: false, userAgent: "Mozilla/5.0 HeadlessChrome/141" })).toEqual({
      webdriver: false,
      headless: true,
    });
  });
});
