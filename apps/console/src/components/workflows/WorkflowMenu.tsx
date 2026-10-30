import { useState } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import { href } from "../../lib/route";

/** The builder's "⋯" menu: the runs, the experiments, the switch, and archiving. Nothing in it changes the steps. */
export function WorkflowMenu({
  name,
  saved,
  published,
  enabled,
  archived = false,
  onToggle,
  onArchive,
}: {
  name: string;
  /** False for a workflow that was never saved: it has no runs, and nothing to pause or archive. */
  saved: boolean;
  published: boolean;
  enabled: boolean;
  /** An archived workflow is restored from the builder's header: only its runs are here. */
  archived?: boolean;
  onToggle: () => void;
  onArchive: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const close = (then: () => void) => () => {
    setOpen(false);
    then();
  };
  return (
    <div className="menu-anchor" ref={ref}>
      <button
        type="button"
        className="btn wf-icon-btn"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!saved}
        title={saved ? undefined : "Save the workflow first"}
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.2" />
          <circle cx="10" cy="10" r="1.2" />
          <circle cx="15.5" cy="10" r="1.2" />
        </svg>
      </button>
      {open && (
        <div className="menu end wf-menu" role="menu">
          <a
            role="menuitem"
            className="menu-link"
            href={href("workflows", name, "runs")}
            onClick={() => setOpen(false)}
          >
            See runs
          </a>
          <a
            role="menuitem"
            className="menu-link"
            href={href("workflows", name, "experiments")}
            onClick={() => setOpen(false)}
          >
            Experiments
          </a>
          {!archived && (
            <>
              <button
                role="menuitem"
                disabled={!published}
                title={published ? undefined : "Publish the workflow first"}
                onClick={close(onToggle)}
              >
                <span className="grow">
                  {enabled ? "Pause" : "Activate"}
                  <small>{enabled ? "The trigger starts no new runs" : "The trigger starts runs again"}</small>
                </span>
              </button>
              <hr />
              <button role="menuitem" className="danger" onClick={close(onArchive)}>
                Archive
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
