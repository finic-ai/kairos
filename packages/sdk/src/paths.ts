const segments = (path: string) => path.split("/").filter(Boolean);

/** The values of the parameters of `pattern` in `path`, or undefined when the path is not the pattern's. */
export function matchPath(pattern: string, path: string): Record<string, string> | undefined {
  const want = segments(pattern);
  const have = segments(path);
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    if (part === "*") return params;
    const value = have[i];
    if (value === undefined) return undefined;
    if (part.startsWith(":")) {
      try {
        params[part.slice(1)] = decodeURIComponent(value);
      } catch {
        params[part.slice(1)] = value;
      }
    } else if (part !== value) return undefined;
  }
  return have.length === want.length ? params : undefined;
}
