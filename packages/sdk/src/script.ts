import { Kairos, pageClient, type BrowserOptions } from "./browser.js";

/**
 * `window.kairos` before the script loads: the options, and the calls of the snippet's stub,
 * which the client makes when it starts.
 */
type Waiting = Partial<BrowserOptions> & { calls?: [method: string, args: unknown[]][] };

const page = window as unknown as { kairos?: Waiting | Kairos };
const tag = document.currentScript as HTMLScriptElement | null;
const waiting = page.kairos instanceof Kairos ? undefined : page.kairos;
const apiKey = waiting?.apiKey ?? tag?.dataset.apiKey;

const kairos =
  pageClient() ??
  (apiKey
    ? new Kairos({
        ...waiting,
        apiKey,
        baseUrl: waiting?.baseUrl ?? tag?.dataset.baseUrl ?? (tag?.src ? new URL(tag.src).origin : undefined),
        cookieDomain: waiting?.cookieDomain ?? tag?.dataset.cookieDomain,
      })
    : undefined);

if (kairos) {
  for (const [method, args] of waiting?.calls ?? []) {
    const call = (kairos as unknown as Record<string, unknown>)[method];
    if (typeof call === "function") call.apply(kairos, args);
  }
  page.kairos = kairos;
}
