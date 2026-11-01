import { SimpleCache } from "fastly:cache";
import { HTMLRewritingStream } from "fastly:html-rewriter";
import { SecretStore } from "fastly:secret-store";
import { fastlyWith, type FastlyFetchEvent, type FastlyOptions } from "./fastly-handler.js";

export type { FastlyFetchEvent, FastlyOptions } from "./fastly-handler.js";

/** `addEventListener("fetch", fastly())`. Needs a backend for your app and one named `kairos`. */
export function fastly(options?: FastlyOptions): (event: FastlyFetchEvent) => void {
  return fastlyWith(
    {
      secret: async (store, name) => (await new SecretStore(store).get(name))?.plaintext(),
      cached: async (key, load) => (await SimpleCache.getOrSet(key, load)).text(),
      appendToHead: (response, html) =>
        new Response(
          response.body!.pipeThrough(new HTMLRewritingStream().onElement("head", (head) => head.append(html))),
          response,
        ),
      fetch: (request, init) => fetch(request, init),
    },
    options,
  );
}
