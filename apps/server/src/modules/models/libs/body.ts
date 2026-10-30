import { gunzipSync } from "node:zlib";

/** Under the Vercel limit for a request body, 4.5 MB. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/** After gzip is removed: a small body can become a very large one. */
export const MAX_MODEL_BYTES = 64 * 1024 * 1024;

export type Upload = { json: unknown } | { status: 400 | 413; message: string };

export async function readUpload(request: Request): Promise<Upload> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  const tooLarge = { status: 413 as const, message: `The body is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` };
  if (declared > MAX_UPLOAD_BYTES) return tooLarge;
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > MAX_UPLOAD_BYTES) return tooLarge;

  let text: Buffer = raw;
  if (/\bgzip\b/i.test(request.headers.get("content-encoding") ?? "")) {
    try {
      text = gunzipSync(raw, { maxOutputLength: MAX_MODEL_BYTES });
    } catch (cause) {
      if ((cause as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
        return { status: 413, message: `The body is larger than ${MAX_MODEL_BYTES / 1024 / 1024} MB without gzip` };
      return { status: 400, message: "The body is not gzip, but Content-Encoding says it is" };
    }
  }
  try {
    return { json: JSON.parse(text.toString("utf8")) };
  } catch {
    return { status: 400, message: "The body is not JSON" };
  }
}
