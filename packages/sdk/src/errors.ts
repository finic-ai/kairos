export class KairosError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "KairosError";
  }
}

/** The API answered with an error status. */
export class KairosApiError extends KairosError {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly requestId?: string,
  ) {
    super(`Kairos API returned ${status}${body ? `: ${body}` : ""}`);
    this.name = "KairosApiError";
  }
}

/** No answer arrived inside the time limit. */
export class KairosTimeoutError extends KairosError {
  constructor(timeoutMs: number) {
    super(`Kairos did not answer in ${timeoutMs} ms`);
    this.name = "KairosTimeoutError";
  }
}
