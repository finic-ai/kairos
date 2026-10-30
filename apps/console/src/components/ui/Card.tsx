import type { ReactNode } from "react";

export function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`card pad ${className}`}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}
