import type { ReactNode } from "react";

const ICONS: Record<string, ReactNode> = {
  event: <path d="M11 2.5 4.5 11.5H10l-1 6 6.5-9H10z" />,
  action: <path d="M10 3v14M3 10h14M5.5 5.500l9 9M14.5 5.500l-9 9" />,
  decision: <path d="m4.5 10.5 3.5 3.5 7.5-8" />,
  entity: (
    <>
      <circle cx="5" cy="10" r="2.2" />
      <circle cx="15" cy="5" r="2.2" />
      <circle cx="15" cy="15" r="2.2" />
      <path d="m7 9 6-3M7 11l6 3" />
    </>
  ),
  label: <path d="M3.5 10.500V4.500h6l7 7-6 6z M7 8h.01" />,
  dashboard: <path d="M3.5 16.500v-6M8 16.500v-12M12.5 16.500v-8M17 16.500v-4" />,
  team: (
    <>
      <circle cx="7.5" cy="7" r="2.8" />
      <path d="M2.5 16.500c.400-2.8 2.4-4.3 5-4.300s4.6 1.5 5 4.300M13.5 4.600a2.6 2.6 0 0 1 0 4.900M15 12.600c1.4.500 2.3 1.8 2.5 3.9" />
    </>
  ),
};

export interface Task {
  id: string;
  icon: keyof typeof ICONS;
  title: string;
  note: string;
  done: boolean;
  waiting?: string;
  body: ReactNode;
}

export function TaskList({
  title,
  tasks,
  open,
  onToggle,
}: {
  title: string;
  tasks: Task[];
  open: string | null;
  onToggle: (id: string) => void;
}) {
  const done = tasks.filter((t) => t.done).length;
  return (
    <section className="start-section">
      <h2>{title}</h2>
      <p className="note">
        {done} of {tasks.length} tasks completed
      </p>
      <div className="card start-list">
        {tasks.map((task) => (
          <div key={task.id} className={`start-task ${open === task.id ? "open" : ""} ${task.done ? "done" : ""}`}>
            <button className="start-head" onClick={() => onToggle(task.id)} aria-expanded={open === task.id}>
              <span className="start-icon">
                <svg viewBox="0 0 20 20">{task.done ? <path d="m4.5 10.5 3.5 3.5 7.5-8" /> : ICONS[task.icon]}</svg>
              </span>
              <span className="grow">
                <b>{task.title}</b>
                <small>{task.note}</small>
              </span>
              {task.done ? (
                <span className="start-state ok">Completed</span>
              ) : (
                task.waiting && (
                  <span className="start-state">
                    <i className="spinner" />
                    {task.waiting}
                  </span>
                )
              )}
              <svg className="caret" viewBox="0 0 20 20">
                <path d="m6 8 4 4 4-4" />
              </svg>
            </button>
            {open === task.id && <div className="start-body">{task.body}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
