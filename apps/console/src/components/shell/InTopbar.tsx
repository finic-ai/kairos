import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Show a page's controls in the top bar: in the trail ("trail-slot") or before the user menu ("topbar-slot"). */
export function InTopbar({ slot, children }: { slot: string; children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(document.getElementById(slot));
  }, [slot]);
  return target ? createPortal(children, target) : null;
}
