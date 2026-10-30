import type { ReactNode } from "react";

export function Group({
  title,
  note,
  action,
  children,
}: {
  title: string;
  note?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="set">
      <div className="set-head">
        <div>
          <h2>{title}</h2>
          {note && <p>{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Row({ title, note, children }: { title: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div>
        <b>{title}</b>
        {note && <small>{note}</small>}
      </div>
      {children && <div className="control">{children}</div>}
    </div>
  );
}
