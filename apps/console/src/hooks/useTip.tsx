import { type ReactNode, useState } from "react";

export function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  return {
    show: (event: React.MouseEvent, body: ReactNode) => setTip({ x: event.clientX, y: event.clientY, body }),
    hide: () => setTip(null),
    node: tip && (
      <div className="tip" style={{ left: tip.x, top: tip.y }}>
        {tip.body}
      </div>
    ),
  };
}
