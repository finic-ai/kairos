import { scopeEntities, type Id } from "./context.js";
import { KairosApiError, KairosError } from "./errors.js";
import { matchPath } from "./paths.js";
import { FormWatch, inputKind, sensitiveForm, type FormLike, type Input, type InputKind } from "./forms.js";
import { automation, deviceId, readBrowser, visitId, type Jar } from "@finic-ai/kairosid";
import { newId, split } from "./properties.js";
import type { ClientSettings, EventProperties, WireEvent } from "./types.js";

/** The part of the client settings that a public key reads. */
export type BrowserSettings = Pick<ClientSettings, "version" | "consent" | "pages" | "screens">;

export interface BrowserOptions {
  /** A public key (`kpk_…`). Limit it to your websites in Settings › API keys. */
  apiKey: string;
  /** The address of Kairos. Default `https://kairos.finic.ai`. The script tag uses the address it was loaded from. */
  baseUrl?: string;
  /** Who is acting, as entity type → id: usually `{ user }`. Leave out what is not known yet. */
  entities?: Record<string, Id>;
  /** The login session in your own system. */
  session?: Id;
  /** Send at least this often, in milliseconds. Default 2000. 0 sends only on `flush` and when the page is left. */
  flushIntervalMs?: number;
  /** The domain of the cookies, such as `example.com`, so that `api.example.com` gets them too. Default: this host only. */
  cookieDomain?: string;
  /** Called when events cannot be sent, or the client settings cannot be read. */
  onError?: (error: Error) => void;
}

/** What the client uses of the browser. Tests give their own. */
export interface BrowserEnvironment {
  location(): { pathname: string; protocol: string };
  referrer(): string;
  cookies(): string;
  setCookie(cookie: string): void;
  storage?: Pick<Storage, "getItem" | "setItem">;
  history?: Pick<History, "pushState" | "replaceState">;
  on(event: "popstate" | "pagehide", listener: () => void): void;
  /** A listener on the document, before the page's own: for forms with a sensitive field. */
  listen(event: FormActivity | "submit", listener: (event: Event) => void): void;
  fetch: typeof fetch;
  /** What every page event says about the browser. */
  facts(): Record<string, unknown>;
  /** Whether a tool drives the browser: WebDriver, or a headless browser that says so. */
  automation(): { webdriver: boolean; headless: boolean };
  /** An id that stays the same in a private window and after the cookies are cleared. */
  browser(): Promise<string | undefined>;
}

type FormActivity = "focusin" | "keydown" | "pointerdown" | "paste";

function browserEnvironment(): BrowserEnvironment {
  return {
    location: () => window.location,
    referrer: () => document.referrer,
    cookies: () => document.cookie,
    setCookie: (cookie) => void (document.cookie = cookie),
    storage: (() => {
      try {
        return window.localStorage;
      } catch {
        return undefined;
      }
    })(),
    history: window.history,
    on: (event, listener) => window.addEventListener(event, listener),
    listen: (event, listener) => document.addEventListener(event, listener, true),
    fetch: window.fetch.bind(window),
    facts: () => ({
      user_agent: navigator.userAgent,
      language: navigator.language,
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: `${screen.width}x${screen.height}`,
    }),
    automation: () => automation(),
    browser: () => readBrowser().then((reading) => reading.id),
  };
}

const RETRY_MS = 60_000;
const FLUSH_AT = 20;
const MAX_BATCH = 500;
const MAX_QUEUE = 1000;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const ACTIVE = Symbol.for("kairos.browser");

/** The client of this page, if one was made: the script tag uses it, so that a page loaded both ways has one. */
export const pageClient = (): Kairos | undefined => (globalThis as { [ACTIVE]?: Kairos })[ACTIVE];

/**
 * The Kairos client for a web page. It gives each browser a device id, sends the page events of
 * the client settings, and sends what you `track`. With a public key only.
 *
 *     const kairos = new Kairos({ apiKey: "kpk_…", entities: { user: user.id } });
 *     kairos.track("coupon_applied", { code: "SPRING10" });
 */
export class Kairos {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly flushIntervalMs: number;
  private readonly cookieDomain: string | undefined;
  private readonly onError: (error: Error) => void;
  private readonly env: BrowserEnvironment;
  private entities: Record<string, Id>;
  private session: Id;
  private settings: BrowserSettings | undefined;
  /** What the page said with `consent`. Until it says, consent is given only when the settings do not ask for it. */
  private consented: boolean | undefined;
  /** The events to send, and whether each takes the visit as its session. */
  private queue: { event: WireEvent; visit: boolean }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private path: string | undefined;
  private watches = new WeakMap<object, FormWatch>();
  // Read only once the page may send.
  private reading: Promise<void> | undefined;
  private browser: string | undefined;

  constructor(options: BrowserOptions, env?: BrowserEnvironment) {
    if (!options.apiKey) throw new KairosError("apiKey is required");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://kairos.finic.ai").replace(/\/+$/, "");
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;
    this.cookieDomain = options.cookieDomain;
    this.onError = options.onError ?? (() => {});
    this.entities = { ...options.entities };
    this.session = options.session;
    this.env = env ?? browserEnvironment();
    if (!env) (globalThis as { [ACTIVE]?: Kairos })[ACTIVE] = this;

    this.env.on("popstate", () => this.navigated());
    this.env.on("pagehide", () => void this.flush(true));
    for (const activity of ["focusin", "keydown", "pointerdown", "paste"] as const)
      this.env.listen(activity, (event) => this.touched(activity, event));
    this.env.listen("submit", (event) => this.submitted(event));
    const { history } = this.env;
    if (history) {
      for (const name of ["pushState", "replaceState"] as const) {
        const original = history[name].bind(history);
        history[name] = (...args: Parameters<History["pushState"]>) => {
          original(...args);
          this.navigated();
        };
      }
    }
    void this.load();
  }

  /** Record an event. It is sent in a batch, and only once the settings and consent allow. */
  track(type: string, properties: EventProperties = {}): void {
    if (!type) throw new KairosError("An event needs a type");
    const { eventId, timestamp, $session, ...rest } = properties;
    const named = split(rest);
    const session = $session === undefined ? this.session : $session;
    this.queue.push({
      event: {
        id: typeof eventId === "string" ? eventId : newId(),
        type,
        ts: (timestamp instanceof Date ? timestamp : new Date(timestamp ?? Date.now())).toISOString(),
        entities: { ...scopeEntities({ entities: this.entities }), ...named.entities },
        properties: { ...named.properties, source: "browser" },
        ...(session === undefined || session === null || session === "" ? {} : { session: String(session) }),
      },
      // `$session: null` says the event has no session; leaving it out takes the visit.
      visit: session === undefined,
    });
    // Before consent, events wait in memory; a page that never gives it keeps only the newest.
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
    if (this.queue.length >= FLUSH_AT) void this.flush();
    else this.schedule();
  }

  /** Say who is acting from now on: after a sign-in in a single-page app, for example. */
  setContext(values: { entities?: Record<string, Id>; session?: Id }): void {
    this.entities = { ...this.entities, ...values.entities };
    if (values.session !== undefined) this.session = values.session;
  }

  /**
   * Start or stop sending. With `consent: "required"` in the settings, nothing is sent and no
   * cookie is set before `consent(true)`. `consent(false)` drops what is waiting.
   */
  consent(given: boolean): void {
    this.consented = given;
    if (given) void this.flush();
    else this.queue = [];
  }

  /**
   * The ids of this browser and of this visit, to send to your server where the cookies do not
   * reach it: a native app, a payment page on another domain. Empty until the page may send.
   */
  ids(): { device?: string; visit?: string } {
    return this.allowed() ? { device: deviceId(this.jar()), visit: visitId(this.jar()) } : {};
  }

  /** Run `fn` with the client. For code that runs before the script tag has loaded; see the snippet. */
  ready(fn: (kairos: Kairos) => void): void {
    fn(this);
  }

  /** Send what is queued, if the settings and consent allow. `leaving` keeps the upload alive as the page goes. */
  async flush(leaving = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.allowed() || this.queue.length === 0) return;
    this.reading ??= this.env.browser().then(
      (id) => void (this.browser = id),
      () => {},
    );
    if (!leaving) await this.reading;
    const waiting = this.queue.splice(0, MAX_BATCH);
    if (waiting.length === 0) return;
    const { browser } = this;
    const device = deviceId(this.jar());
    const visit = visitId(this.jar());
    const batch = waiting.map(({ event, visit: takesVisit }) => ({
      ...event,
      entities: { device, ...(browser ? { browser } : {}), ...event.entities },
      ...(takesVisit ? { session: visit } : {}),
    }));
    try {
      const response = await this.env.fetch(`${this.baseUrl}/v1/events`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ batch }),
        keepalive: leaving,
      });
      if (!response.ok)
        throw new KairosApiError(response.status, (await response.text().catch(() => "")).slice(0, 500));
    } catch (cause) {
      const error = cause instanceof Error ? cause : new KairosError(String(cause));
      // A rejected batch will be rejected again, so it is dropped.
      if (!(error instanceof KairosApiError) || RETRYABLE.has(error.status)) this.queue.unshift(...waiting);
      this.onError(error);
    }
  }

  private allowed(): boolean {
    if (!this.settings) return false;
    return this.consented ?? this.settings.consent === "not_required";
  }

  private jar(): Jar {
    return {
      cookies: () => this.env.cookies(),
      setCookie: (cookie) => this.env.setCookie(cookie),
      storage: this.env.storage,
      secure: this.env.location().protocol === "https:",
      domain: this.cookieDomain,
    };
  }

  private schedule(): void {
    if (this.timer || this.flushIntervalMs <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private async load(): Promise<void> {
    try {
      const response = await this.env.fetch(`${this.baseUrl}/v1/client-settings`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!response.ok)
        throw new KairosApiError(response.status, (await response.text().catch(() => "")).slice(0, 500));
      this.settings = (await response.json()) as BrowserSettings;
    } catch (cause) {
      this.onError(cause instanceof Error ? cause : new KairosError(String(cause)));
      setTimeout(() => void this.load(), RETRY_MS);
      return;
    }
    this.navigated();
    void this.flush();
  }

  /** The event of the page the browser is on, once for each new path, when the settings name the page. */
  private navigated(): void {
    if (!this.settings) return;
    const { pathname } = this.env.location();
    if (pathname === this.path) return;
    this.path = pathname;
    const page = this.settings.pages.find((p) => matchPath(p.path, pathname));
    if (page)
      this.track(page.type, {
        path: pathname,
        referrer: this.env.referrer() || undefined,
        ...this.env.facts(),
        ...this.env.automation(),
      });
  }

  /** The form with a sensitive field that an event of the page is in. */
  private formOf(
    target: EventTarget | null,
  ): { form: FormLike; facts: { form: string; fields: InputKind[] } } | undefined {
    const form = (target as { closest?: (selector: string) => FormLike | null } | null)?.closest?.("form");
    const facts = form ? sensitiveForm(form) : undefined;
    return form && facts ? { form, facts } : undefined;
  }

  private touched(activity: FormActivity, event: Event): void {
    const found = this.formOf(event.target);
    if (!found) return;
    let watch = this.watches.get(found.form);
    if (!watch) this.watches.set(found.form, (watch = new FormWatch(Date.now())));
    if (activity === "keydown") watch.key();
    else if (activity === "pointerdown") watch.point();
    else if (activity === "paste") watch.paste(inputKind(event.target as Input));
  }

  /** The event of a form with a sensitive field: how it was filled in, never what with. */
  private submitted(event: Event): void {
    const found = this.formOf(event.target);
    if (!found) return;
    const watch = this.watches.get(found.form) ?? new FormWatch(Date.now());
    this.watches.delete(found.form);
    this.track("form_submitted", {
      path: this.env.location().pathname,
      ...found.facts,
      ...watch.summary(Date.now(), event.isTrusted),
      ...this.env.automation(),
    });
  }
}
