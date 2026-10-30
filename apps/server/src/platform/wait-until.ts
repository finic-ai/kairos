/**
 * Keep a serverless function running after its answer until `promise` ends. On Vercel the
 * runtime puts a request context on `globalThis` under this symbol; it is what the
 * `@vercel/functions` package reads, without adding the package. Elsewhere the promise simply
 * runs, as it would in any long-running process.
 */
const CONTEXT = Symbol.for("@vercel/request-context");

export function waitUntil(promise: Promise<unknown>): void {
  const context = (
    globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>
  )[CONTEXT]?.get?.();
  const guarded = promise.catch((cause) => console.error(cause));
  context?.waitUntil?.(guarded);
}
