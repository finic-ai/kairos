import { afterEach, describe, expect, it, vi } from "vitest";
import { Kairos, type BrowserEnvironment, type BrowserSettings } from "../src/browser.js";
import { inputKind } from "../src/forms.js";

/** A page at `path`, whose requests to Kairos are recorded and answered with `settings`. */
function page(settings: Partial<BrowserSettings> | number, path = "/") {
  const sent: any[][] = [];
  const asked: { url: string; init: RequestInit }[] = [];
  const jar = new Map([["theme", "dark"]]);
  const setCookies: string[] = [];
  const stored = new Map<string, string>();
  const listeners: Record<string, () => void> = {};
  const documentListeners: Record<string, (event: Event) => void> = {};
  const automation = { webdriver: false, headless: false };
  const browser: { id: string | undefined } = { id: "browser_1" };
  const location = { pathname: path, protocol: "https:" };
  const history = {
    pushState: (_data: unknown, _unused: string, url?: string | URL | null) => void (location.pathname = String(url)),
    replaceState: (_data: unknown, _unused: string, url?: string | URL | null) =>
      void (location.pathname = String(url)),
  };
  const env: BrowserEnvironment = {
    location: () => location,
    referrer: () => "https://search.example/",
    cookies: () => [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
    setCookie: (value) => {
      setCookies.push(value);
      const [pair] = value.split(";");
      jar.set(pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1));
    },
    storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value) },
    history,
    on: (event, listener) => void (listeners[event] = listener),
    listen: (event, listener) => void (documentListeners[event] = listener),
    fetch: (async (url: string, init: RequestInit = {}) => {
      asked.push({ url, init });
      if (url.endsWith("/v1/client-settings"))
        return typeof settings === "number"
          ? new Response("{}", { status: settings })
          : new Response(JSON.stringify({ version: 1, consent: "not_required", pages: [], screens: [], ...settings }));
      sent.push(JSON.parse(String(init.body)).batch);
      return new Response('{"accepted":1}', { status: 202 });
    }) as typeof fetch,
    facts: () => ({ language: "en-GB" }),
    automation: () => automation,
    browser: async () => browser.id,
  };
  /** An event of the page on `target`, as the document's listener gets it. */
  const dispatch = (type: string, target: unknown, isTrusted = true) =>
    documentListeners[type]!({ type, target, isTrusted } as unknown as Event);
  return { env, sent, asked, history, listeners, dispatch, automation, browser, jar, setCookies, stored };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const withoutIds = (batches: any[][]) => batches.flat().map(({ id: _id, ts: _ts, ...event }) => event);

describe("the browser client", () => {
  it("sends the events of the pages in the settings, and of the paths the page goes to", async () => {
    const p = page(
      {
        pages: [
          { path: "/checkout", type: "checkout_viewed" },
          { path: "/account/*", type: "account_viewed" },
        ],
      },
      "/checkout",
    );
    const kairos = new Kairos(
      {
        apiKey: "kpk_site",
        baseUrl: "https://kairos.test/",
        entities: { user: "u1", device: "" },
        session: "s1",
        flushIntervalMs: 0,
      },
      p.env,
    );
    await settle();
    p.history.pushState(null, "", "/account/security");
    p.history.replaceState(null, "", "/account/security");
    p.history.pushState(null, "", "/about");
    p.listeners.popstate!();
    await kairos.flush();

    const device = p.stored.get("kairos_device")!;
    expect(device).toMatch(/.+/);
    expect(p.env.cookies()).toBe(`theme=dark; kairos_device=${device}; kairos_visit=${p.jar.get("kairos_visit")}`);
    const facts = {
      referrer: "https://search.example/",
      language: "en-GB",
      webdriver: false,
      headless: false,
      source: "browser",
    };
    expect(withoutIds(p.sent)).toEqual([
      {
        type: "checkout_viewed",
        entities: { device, browser: "browser_1", user: "u1" },
        session: "s1",
        properties: { path: "/checkout", ...facts },
      },
      {
        type: "account_viewed",
        entities: { device, browser: "browser_1", user: "u1" },
        session: "s1",
        properties: { path: "/account/security", ...facts },
      },
    ]);
    expect(p.asked[0]).toMatchObject({
      url: "https://kairos.test/v1/client-settings",
      init: { headers: { Authorization: "Bearer kpk_site" } },
    });
  });

  it("sends what is tracked, with the context and the entities that the call names", async () => {
    const p = page({});
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0 }, p.env);
    kairos.track("coupon_applied", { code: "SPRING10", payeeId: "p7" });
    kairos.setContext({ entities: { user: "u9" }, session: "fresh" });
    kairos.track("signed_in", { $session: null });
    await settle();
    await kairos.flush();
    const device = p.stored.get("kairos_device")!;
    expect(withoutIds(p.sent)).toEqual([
      {
        type: "coupon_applied",
        entities: { device, browser: "browser_1", payee: "p7" },
        session: p.jar.get("kairos_visit"),
        properties: { code: "SPRING10", source: "browser" },
      },
      {
        type: "signed_in",
        entities: { device, browser: "browser_1", user: "u9" },
        properties: { source: "browser" },
      },
    ]);
    expect(p.asked.find((a) => a.url.endsWith("/v1/events"))!.url).toBe("https://kairos.finic.ai/v1/events");
  });

  it("names the browser only when it could be read", async () => {
    const p = page({});
    p.browser.id = undefined;
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0 }, p.env);
    kairos.track("seen");
    await settle();
    await kairos.flush();
    expect(Object.keys(p.sent[0]![0].entities)).toEqual(["device"]);
  });

  it("does not wait for the browser as the page goes", async () => {
    const p = page({});
    p.env.browser = () => new Promise(() => {});
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0 }, p.env);
    kairos.track("seen");
    await settle();
    p.listeners.pagehide!();
    await settle();
    expect(p.sent.flat().map((event) => Object.keys(event.entities))).toEqual([["device"]]);
  });

  it("keeps the device of the browser", async () => {
    const p = page({});
    p.env.setCookie("kairos_device=known; Path=/");
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0 }, p.env);
    kairos.track("seen");
    await settle();
    await kairos.flush();
    expect(p.sent[0]![0].entities.device).toBe("known");
  });

  it("sends nothing and sets no cookie before consent, when the settings ask for it", async () => {
    const p = page({ consent: "required", pages: [{ path: "/", type: "home_viewed" }] });
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0 }, p.env);
    kairos.track("seen");
    await settle();
    await kairos.flush();
    expect(p.sent).toEqual([]);
    expect(p.env.cookies()).toBe("theme=dark");

    kairos.consent(true);
    await settle();
    expect(withoutIds(p.sent).map((e) => e.type)).toEqual(["seen", "home_viewed"]);

    kairos.consent(false);
    kairos.track("later");
    await kairos.flush();
    expect(p.sent).toHaveLength(1);
  });

  it("sends nothing while the settings cannot be read, even as the page is left, and says why", async () => {
    const errors: Error[] = [];
    const p = page(403);
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0, onError: (e) => errors.push(e) }, p.env);
    kairos.track("seen");
    await settle();
    p.listeners.pagehide!();
    await settle();
    expect(p.sent).toEqual([]);
    expect(errors.map((e) => (e as any).status)).toEqual([403]);
  });

  it("sends a batch again after a failure that can pass, and drops one that was refused", async () => {
    const errors: Error[] = [];
    const p = page({});
    let answer = 503;
    const send = p.env.fetch;
    p.env.fetch = (async (url: string, init?: RequestInit) =>
      url.endsWith("/v1/events") && answer !== 202
        ? new Response("{}", { status: answer })
        : send(url, init)) as typeof fetch;
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0, onError: (e) => errors.push(e) }, p.env);
    kairos.track("first");
    await settle();
    await kairos.flush();
    answer = 400;
    await kairos.flush();
    answer = 202;
    kairos.track("second");
    await kairos.flush();
    expect(withoutIds(p.sent).map((e) => e.type)).toEqual(["second"]);
    expect(errors.map((e) => (e as any).status)).toEqual([503, 503, 400]);
  });
});

describe("the ids of the browser and the visit", () => {
  afterEach(() => vi.useRealTimers());

  it("keep a visit for 30 minutes after its last event, and start a new one after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T10:00:00Z"));
    const p = page({});
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0 }, p.env);
    await settle();
    const visits: unknown[] = [];
    for (const minutes of [0, 20, 49, 85]) {
      vi.setSystemTime(new Date(Date.parse("2026-10-31T10:00:00Z") + minutes * 60_000));
      kairos.track("seen");
      await kairos.flush();
      visits.push(p.sent.at(-1)![0].session);
    }
    expect(visits[0]).toBe(visits[1]);
    expect(visits[1]).toBe(visits[2]);
    expect(visits[3]).not.toBe(visits[2]);
  });

  it("set the cookies for the domain the page asks for, the device's for a year and the visit's for the session", async () => {
    const p = page({});
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0, cookieDomain: "example.com" }, p.env);
    kairos.track("seen");
    await settle();
    await kairos.flush();
    const [device, visit] = p.setCookies;
    expect(device).toMatch(
      /^kairos_device=[^;]+; Max-Age=31536000; Path=\/; Domain=example.com; SameSite=Lax; Secure$/,
    );
    expect(visit).toMatch(/^kairos_visit=[^;]+; Path=\/; Domain=example.com; SameSite=Lax; Secure$/);
  });

  it("give the ids to the page once it may send", async () => {
    const p = page({ consent: "required" });
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0 }, p.env);
    await settle();
    expect(kairos.ids()).toEqual({});
    kairos.consent(true);
    expect(kairos.ids()).toEqual({ device: p.jar.get("kairos_device"), visit: p.jar.get("kairos_visit") });
  });
});

describe("forms with a sensitive field", () => {
  /** A form, and fields of it, as the page's events have them as targets. */
  const formWith = (fields: Record<string, string>[], names: { id?: string; name?: string; action?: string } = {}) => {
    const form: Record<string, unknown> = { ...names };
    const closest = (selector: string) => (selector === "form" ? form : null);
    const elements = fields.map((input) => ({ ...input, closest }));
    Object.assign(form, { elements, closest });
    return { form, elements };
  };
  const login = () =>
    formWith(
      [
        { type: "email", name: "email" },
        { type: "password", name: "pw" },
      ],
      { id: "login" },
    );

  it("send how the form was filled in when it is submitted, and never what with", async () => {
    const p = page({}, "/login");
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0 }, p.env);
    await settle();
    const {
      form,
      elements: [email, password],
    } = login();
    p.dispatch("focusin", email);
    for (let i = 0; i < 3; i++) p.dispatch("keydown", email);
    p.dispatch("pointerdown", password);
    p.dispatch("paste", password);
    p.dispatch("paste", password);
    await new Promise((resolve) => setTimeout(resolve, 15));
    p.dispatch("submit", form);
    await kairos.flush();

    const [event] = withoutIds(p.sent);
    expect(event.type).toBe("form_submitted");
    expect(event.properties).toMatchObject({
      path: "/login",
      form: "login",
      fields: ["email", "password"],
      pasted: ["password"],
      paste_count: 2,
      keys: 3,
      pointer: true,
      trusted: true,
      webdriver: false,
      headless: false,
      source: "browser",
    });
    expect(event.properties.duration_ms).toBeGreaterThanOrEqual(10);
  });

  it("show a submit that a script made, with no one at the form", async () => {
    const p = page({}, "/login");
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0 }, p.env);
    await settle();
    p.automation.webdriver = true;
    p.dispatch("submit", login().form, false);
    await kairos.flush();
    expect(withoutIds(p.sent)[0].properties).toMatchObject({
      duration_ms: 0,
      pasted: [],
      paste_count: 0,
      keys: 0,
      pointer: false,
      trusted: false,
      webdriver: true,
    });
  });

  it("leave alone a form with no sensitive field, and what is in no form", async () => {
    const p = page({}, "/search");
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0 }, p.env);
    await settle();
    const search = formWith(
      [
        { type: "search", name: "q" },
        { type: "email", name: "newsletter" },
      ],
      { id: "search" },
    );
    p.dispatch("keydown", search.elements[0]);
    p.dispatch("submit", search.form);
    p.dispatch("submit", { closest: () => null });
    p.dispatch("submit", {});
    await kairos.flush();
    expect(p.sent).toEqual([]);
  });

  it("name a form by its id, its name, or else the path of its action", async () => {
    const p = page({});
    const kairos = new Kairos({ apiKey: "kpk_site", flushIntervalMs: 0 }, p.env);
    await settle();
    const card = [{ autocomplete: "cc-number" }];
    p.dispatch("submit", formWith(card, { name: "pay" }).form);
    p.dispatch("submit", formWith(card, { action: "https://shop.example/api/pay?step=2" }).form);
    // A field named "id" hides the form's own id.
    p.dispatch("submit", formWith(card, { id: { tagName: "INPUT" } as unknown as string, action: "/checkout" }).form);
    await kairos.flush();
    expect(withoutIds(p.sent).map((e) => e.properties.form)).toEqual(["pay", "/api/pay", "/checkout"]);
  });

  it("know what a field holds from what the page says about it", () => {
    expect(inputKind({ type: "password" })).toBe("password");
    expect(inputKind({ autocomplete: "cc-number" })).toBe("card");
    expect(inputKind({ autocomplete: "one-time-code" })).toBe("otp");
    expect(inputKind({ name: "payee_iban" })).toBe("account");
    expect(inputKind({ id: "sort-code" })).toBe("account");
    expect(inputKind({ type: "email" })).toBe("email");
    expect(inputKind({ type: "tel" })).toBe("phone");
    expect(inputKind({ name: "coupon" })).toBe("other");
  });
});
