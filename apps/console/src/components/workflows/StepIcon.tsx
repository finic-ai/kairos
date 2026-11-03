import type { ReactNode } from "react";
import type { StepIcon as Icon } from "../../lib/workflows";

const SHIELD = (
  <>
    <path d="M10 3 3 6v4c0 4 3 6.5 7 7.5 4-1 7-3.5 7-7.5V6z" />
    <path d="m7 10 2 2 4-4" />
  </>
);

const PATHS: Record<
  Icon | "trigger" | "manual" | "event" | "record" | "scheduled" | "webhook" | "decision",
  ReactNode
> = {
  record: (
    <>
      <ellipse cx="10" cy="5" rx="6" ry="2.3" />
      <path d="M4 5v10c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3V5M4 10c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3" />
    </>
  ),
  trigger: <path d="M11 2.5 4.5 11.5H10l-1 6 6.5-9H10z" />,
  manual: (
    <path d="M7 9V4.5a1.5 1.5 0 0 1 3 0V9m0-1.5a1.5 1.5 0 0 1 3 0V10m0-1a1.5 1.5 0 0 1 3 0v3.5a5 5 0 0 1-5 5h-1a5 5 0 0 1-4.1-2.1L3.5 12a1.4 1.4 0 0 1 2.2-1.7L7 12" />
  ),
  event: (
    <>
      <path d="M3 5h10M3 10h14M3 15h8" />
      <circle cx="16" cy="5" r="1.6" />
    </>
  ),
  scheduled: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.8 1.8" />
    </>
  ),
  webhook: (
    <>
      <circle cx="6" cy="14" r="2.2" />
      <circle cx="14" cy="14" r="2.2" />
      <circle cx="10" cy="5.5" r="2.2" />
      <path d="M8.2 14h3.6M9 7.5l-2 4.4M11 7.5l2 4.4" />
    </>
  ),
  condition: <path d="M4 4v4a3 3 0 0 0 3 3h6M4 16v-5M13 8l3 3-3 3" />,
  filter: <path d="M3 4h14l-5.5 6.5V16l-3-1.5v-4z" />,
  loop: <path d="M4 9a5 5 0 0 1 9-3l2 2M16 11a5 5 0 0 1-9 3l-2-2M15 4v4h-4M5 16v-4h4" />,
  return: <path d="M15 4v7a3 3 0 0 1-3 3H5M8 11l-3 3 3 3" />,
  delay: (
    <>
      <path d="M6 3h8M6 17h8" />
      <path d="M7 3c0 4 6 3 6 7s-6 3-6 7M13 3c0 4-6 3-6 7s6 3 6 7" />
    </>
  ),
  http: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3c2 2 3 4.5 3 7s-1 5-3 7c-2-2-3-4.5-3-7s1-5 3-7z" />
    </>
  ),
  search: (
    <>
      <circle cx="9" cy="9" r="5" />
      <path d="m13 13 4 4" />
    </>
  ),
  get: (
    <>
      <rect x="4" y="3" width="12" height="14" rx="1.5" />
      <path d="M7 7h6M7 10h6M7 13h3" />
    </>
  ),
  create: (
    <>
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <path d="M10 7v6M7 10h6" />
    </>
  ),
  update: <path d="M4 16h3l8.5-8.5a2.1 2.1 0 0 0-3-3L4 13zM11 6l3 3" />,
  decide: SHIELD,
  decision: SHIELD,
  answer: <path d="M4 4.5h12v8.5H9.5L6 16v-3H4z" />,
  assess: (
    <>
      <path d="M10 3 3 6v4c0 4 3 6.5 7 7.5 4-1 7-3.5 7-7.5V6z" />
      <path d="M10 7v3.5M10 12.8v.2" />
    </>
  ),
  ask: (
    <>
      <circle cx="10" cy="10" r="7" />
      <path d="M7.8 8.2a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.4M10 14.3v.2" />
    </>
  ),
  score: (
    <>
      <path d="M3.5 14a6.5 6.5 0 1 1 13 0" />
      <path d="m10 14 3-4.5" />
    </>
  ),
  case: <path d="M3 11h4l1.5 2h3L13 11h4M3 11l2-6h10l2 6v5H3z" />,
  ruleset: (
    <>
      <path d="M4 5h12M4 10h7M4 15h5" />
      <path d="m12.5 14 1.8 1.8 3.2-3.6" />
    </>
  ),
  list: (
    <>
      <path d="M7 5h9M7 10h9M7 15h9" />
      <path d="M3.5 5h.5M3.5 10h.5M3.5 15h.5" />
    </>
  ),
};

/** The colour of a group of steps, as a class. */
const TONE: Record<string, string> = {
  condition: "flow",
  filter: "flow",
  loop: "flow",
  delay: "flow",
  search: "records",
  get: "records",
  create: "records",
  update: "records",
  decide: "decide",
  case: "decide",
  ruleset: "decide",
  list: "records",
  http: "http",
};

export function StepIcon({ icon, tone }: { icon: keyof typeof PATHS; tone?: string }) {
  return (
    <span className={`wf-icon ${tone ?? TONE[icon] ?? "trigger"}`}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        {PATHS[icon]}
      </svg>
    </span>
  );
}
