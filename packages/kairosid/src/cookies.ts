export const DEVICE_COOKIE = "kairos_device";
export const VISIT_COOKIE = "kairos_visit";

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const at = part.indexOf("=");
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    const value = part.slice(at + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}
