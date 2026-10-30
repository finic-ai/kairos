import type { ReactNode } from "react";

export function Steps({ steps }: { steps: { title: string; body: ReactNode }[] }) {
  return (
    <ol className="steps">
      {steps.map((step, i) => (
        <li key={i}>
          <span className="n">{i + 1}</span>
          <div>
            <b>{step.title}</b>
            {step.body}
          </div>
        </li>
      ))}
    </ol>
  );
}
