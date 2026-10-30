import type { ReactNode } from "react";

export function Panel({
  title,
  note,
  link,
  span,
  children,
}: {
  title: string;
  note?: string;
  link?: ReactNode;
  span: number;
  children: ReactNode;
}) {
  return (
    <section className={`card panel span-${span}`}>
      <div className="panel-head">
        <h3>{title}</h3>
        {link ?? (note && <span>{note}</span>)}
      </div>
      {children}
    </section>
  );
}
