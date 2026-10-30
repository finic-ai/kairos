import type { Question } from "./questions";

export interface GraysonRequest {
  model: string;
  context: unknown;
  questions: Record<string, Question>;
}

export type GraysonAnswer =
  | { type: "noul"; value: boolean; probability: number }
  | { type: "choice"; value: string; probabilities: Record<string, number> }
  | { type: "multi_choice"; values: string[]; probabilities: Record<string, number> }
  | { type: "score"; value: number; level: string; probabilities: number[] };

export interface GraysonResponse {
  id: string;
  model: string;
  answers: Record<string, GraysonAnswer>;
  usage: { input_tokens: number };
}

/** Anything that can answer a Grayson request. The evaluation suite wraps the client in a cache. */
export type Decider = (request: GraysonRequest) => Promise<GraysonResponse>;

export class GraysonError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "GraysonError";
  }
}

export interface GraysonClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Client for `POST /v1/decide`. Retries rate limits, server errors and network failures with backoff. */
export function createGraysonClient(options: GraysonClientOptions): Decider {
  const { apiKey, baseUrl = "https://api.finic.ai", timeoutMs = 30_000, maxRetries = 4 } = options;
  const doFetch = options.fetch ?? fetch;

  return async (request) => {
    let lastError: GraysonError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      try {
        const response = await doFetch(`${baseUrl}/v1/decide`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) return (await response.json()) as GraysonResponse;
        const body = (await response.text()).slice(0, 500);
        lastError = new GraysonError(`Grayson returned ${response.status}`, response.status, body);
        if (!RETRYABLE.has(response.status)) throw lastError;
      } catch (error) {
        if (error instanceof GraysonError && error.status !== undefined && !RETRYABLE.has(error.status)) throw error;
        lastError =
          error instanceof GraysonError ? error : new GraysonError(`Grayson request failed: ${String(error)}`);
      }
    }
    throw lastError ?? new GraysonError("Grayson request failed");
  };
}
