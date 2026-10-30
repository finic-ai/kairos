import { useRef, useState } from "react";
import type { Environment } from "../../types/interfaces";
import { useDismiss } from "../../hooks/useDismiss";

export function EnvironmentMenu({
  environments,
  environment,
  onChoose,
}: {
  environments: Environment[];
  environment: Environment;
  onChoose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const ref = useDismiss(open, () => setOpen(false));
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
      trigger.current?.focus();
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (!open) return setOpen(true);
    const options = Array.from(ref.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? options.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[index]?.focus();
  };
  return (
    <div
      className="menu-anchor environment-menu"
      ref={ref}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className={`environment-switcher ${environment.kind}`}
        aria-label={`Switch environment: ${environment.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${environment.name} · ${environment.kind === "production" ? "Production" : "Sandbox"}`}
        onClick={() => setOpen(!open)}
      >
        <span>
          {environment.kind === "sandbox" ? "Sandbox · " : ""}
          {environment.name}
        </span>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m6 8 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div className="menu environment-options" role="menu" aria-label="Environments">
          {environments.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitemradio"
              aria-checked={item.id === environment.id}
              autoFocus={item.id === environment.id}
              onClick={() => {
                setOpen(false);
                if (item.id !== environment.id) onChoose(item.id);
                else trigger.current?.focus();
              }}
            >
              <span className="grow">
                {item.name}
                <small>{item.kind === "production" ? "Production" : "Sandbox"}</small>
              </span>
              {item.id === environment.id && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
