const HIDDEN = "kairos.start.hidden.";

export function startHidden(environmentId: string): boolean {
  try {
    return localStorage.getItem(HIDDEN + environmentId) === "1";
  } catch {
    return false;
  }
}

export function setStartHidden(environmentId: string, hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(HIDDEN + environmentId, "1");
    else localStorage.removeItem(HIDDEN + environmentId);
  } catch {}
}
