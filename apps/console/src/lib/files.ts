export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"];
/** Files a tab can show without running anything. A blob address belongs to the console, so any other file is downloaded. */
export const INLINE_TYPES = [...IMAGE_TYPES, "application/pdf", "text/plain"];

/** Opens a file in `tab`, opened already on the click so a pop-up blocker allows it, or downloads it. */
export function openFile(blob: Blob, name: string, tab: Window | null) {
  if (INLINE_TYPES.includes(blob.type)) {
    if (tab) tab.location.href = URL.createObjectURL(blob);
    return;
  }
  tab?.close();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  link.download = name;
  link.click();
}
