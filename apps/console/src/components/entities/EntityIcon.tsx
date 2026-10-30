import { ReactNode } from "react";
import { displayOf, EntityColor, EntityIcon as IconName } from "@kairos/core";
import type { EntityDefinition } from "../../types/interfaces";

const PATHS: Record<IconName, ReactNode> = {
  person: (
    <>
      <circle cx="10" cy="6.5" r="3" />
      <path d="M4 17c.8-3.2 3.1-5 6-5s5.2 1.8 6 5" />
    </>
  ),
  people: (
    <>
      <circle cx="7.5" cy="7" r="2.5" />
      <path d="M2.5 16c.6-2.6 2.5-4 5-4s4.4 1.4 5 4" />
      <circle cx="13.5" cy="7.5" r="2" />
      <path d="M13.5 12c2 0 3.5 1.2 4 3.5" />
    </>
  ),
  store: (
    <path d="M3 7.5 4.5 3.5h11L17 7.5M3 7.5a2.3 2.3 0 0 0 4.7 0 2.3 2.3 0 0 0 4.6 0 2.3 2.3 0 0 0 4.7 0M4 9.5v7h12v-7M8 16.5v-4h4v4" />
  ),
  banknote: (
    <>
      <rect x="2.5" y="5" width="15" height="10" rx="1.5" />
      <circle cx="10" cy="10" r="2.2" />
      <path d="M5.5 8v4M14.5 8v4" />
    </>
  ),
  fingerprint: (
    <path d="M5 8a5 5 0 0 1 10 0v2M3.5 12.5a14 14 0 0 0 .5-4.5M7.5 16.5a12 12 0 0 0 1-5.5V8a1.5 1.5 0 0 1 3 0v2.5M11 17c.5-1 .9-2 1.2-3.2M15 13.5c-.1.8-.3 1.6-.5 2.3" />
  ),
  home: <path d="M3 9.5 10 3.5l7 6M5 8v8.5h10V8M8.5 16.5v-4h3v4" />,
  flag: <path d="M4.5 17.5V3M4.5 3.5h9l-1.8 3.5 1.8 3.5h-9" />,
  stethoscope: (
    <>
      <path d="M5 3v4a3.5 3.5 0 0 0 7 0V3M8.5 10.5v2a4 4 0 0 0 8 0V11" />
      <circle cx="16.5" cy="9.5" r="1.5" />
    </>
  ),
  flask: <path d="M8 2.5h4M8.5 2.5v5L4 15.5a1.3 1.3 0 0 0 1.1 2h9.8a1.3 1.3 0 0 0 1.1-2l-4.5-8v-5M6 12h8" />,
  shield: <path d="M10 2.5 16 5v4.5c0 3.8-2.6 6.6-6 8-3.4-1.4-6-4.2-6-8V5z" />,
  scales: <path d="M10 3v14M6 17h8M4 6h12M4 6l-2 5a2.5 2.5 0 0 0 4 0zM16 6l-2 5a2.5 2.5 0 0 0 4 0z" />,
  wrench: (
    <path d="M12.5 3.2a4 4 0 0 0-4.9 5.2L3 13a1.8 1.8 0 0 0 2.5 2.5L10 11a4 4 0 0 0 5.3-4.8l-2.4 2.4-2-.5-.5-2z" />
  ),
  business: <path d="M4 17V4.5h8V17M12 8.5h4V17M2.5 17h15M6.5 7.5h3M6.5 10.5h3M6.5 13.5h3" />,
  card: (
    <>
      <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
      <path d="M2.5 8h15M5.5 12.5h3" />
    </>
  ),
  bank: <path d="M2.5 7.5 10 3l7.5 4.5zM3.5 16.5h13M4.5 9.5v5M8 9.5v5M12 9.5v5M15.5 9.5v5" />,
  wallet: (
    <>
      <path d="M3 6.5a2 2 0 0 1 2-2h9v2" />
      <rect x="3" y="6.5" width="14" height="10" rx="2" />
      <circle cx="13.5" cy="11.5" r="1" />
    </>
  ),
  arrow_in: (
    <>
      <path d="M2.5 17.5 17.5 11l-6-2.5-2.5-6z" />
      <path d="m2.5 17.5 9-9" />
    </>
  ),
  arrow_out: (
    <>
      <path d="M17.5 2.5 2.5 9l6 2.5 2.5 6z" />
      <path d="m17.5 2.5-9 9" />
    </>
  ),
  device: (
    <>
      <rect x="5.5" y="2.5" width="9" height="15" rx="2" />
      <path d="M9 14.5h2" />
    </>
  ),
  phone: (
    <path d="M4.5 3h2.8l1.4 3.5-1.8 1.1a8.5 8.5 0 0 0 4.5 4.5l1.1-1.8 3.5 1.4v2.8A1.5 1.5 0 0 1 14.5 16 11.5 11.5 0 0 1 3 4.5 1.5 1.5 0 0 1 4.5 3z" />
  ),
  mail: (
    <>
      <rect x="2.5" y="4.5" width="15" height="11" rx="2" />
      <path d="m3 5.5 7 5.5 7-5.5" />
    </>
  ),
  document: (
    <>
      <rect x="2.5" y="4" width="15" height="12" rx="2" />
      <circle cx="7" cy="9" r="1.8" />
      <path d="M4.8 13.2c.5-1.3 1.2-2 2.2-2s1.7.7 2.2 2M11.5 8h3.5M11.5 11h3.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M2.5 10h15M10 2.5c2.2 2.3 3 4.8 3 7.5s-.8 5.2-3 7.5c-2.2-2.3-3-4.8-3-7.5s.8-5.2 3-7.5z" />
    </>
  ),
  pin: (
    <>
      <path d="M10 17.5s5.5-5.2 5.5-9.5a5.5 5.5 0 0 0-11 0c0 4.3 5.5 9.5 5.5 9.5z" />
      <circle cx="10" cy="8" r="2" />
    </>
  ),
  hospital: (
    <>
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <path d="M10 6.5v7M6.5 10h7" />
    </>
  ),
  link: (
    <path d="M8.5 11.5a3.2 3.2 0 0 0 4.5 0l2.5-2.5a3.2 3.2 0 0 0-4.5-4.5l-1 1M11.5 8.5a3.2 3.2 0 0 0-4.5 0L4.5 11a3.2 3.2 0 0 0 4.5 4.5l1-1" />
  ),
  tag: (
    <>
      <path d="M3 3h6.5l8 8-6.5 6.5-8-8z" />
      <circle cx="6.5" cy="6.5" r="1.2" />
    </>
  ),
  box: <path d="M3 6.5 10 3l7 3.5v7L10 17l-7-3.5zM3 6.5l7 3.5 7-3.5M10 10v7" />,
  car: (
    <>
      <path d="M3.5 13.5v-3l1.8-4.2a1.5 1.5 0 0 1 1.4-.8h6.6a1.5 1.5 0 0 1 1.4.8l1.8 4.2v3zM3.5 10.5h13" />
      <circle cx="6.5" cy="13.5" r="1.5" />
      <circle cx="13.5" cy="13.5" r="1.5" />
    </>
  ),
  receipt: <path d="M5 2.5h10v15l-2-1.3-1.5 1.3-1.5-1.3-1.5 1.3-1.5-1.3-2 1.3zM7.5 6.5h5M7.5 9.5h5M7.5 12.5h3" />,
};

export function EntityIcon({
  icon,
  color,
  size = "md",
  title,
}: {
  icon: IconName;
  color: EntityColor;
  size?: "sm" | "md" | "lg";
  title?: string;
}) {
  return (
    <span className={`ent-icon ent-${color} ${size}`} title={title} aria-hidden={title ? undefined : true}>
      <svg viewBox="0 0 20 20">{PATHS[icon]}</svg>
    </span>
  );
}

export function TypeIcon({
  type,
  definition,
  size,
}: {
  type: string;
  definition?: EntityDefinition | null;
  size?: "sm" | "md" | "lg";
}) {
  const { icon, color } = displayOf(type, definition);
  return <EntityIcon icon={icon} color={color} size={size} />;
}
