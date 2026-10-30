export const hashQuery = () => new URLSearchParams(window.location.hash.split("?")[1] ?? "");

export const href = (...segments: string[]) => `#/${segments.map(encodeURIComponent).join("/")}`;
export const go = (...segments: string[]) => (window.location.hash = href(...segments));

let appRoute: string[] = ["overview"];
export const lastAppRoute = () => appRoute;
export const rememberAppRoute = (route: string[]) => void (appRoute = route);
