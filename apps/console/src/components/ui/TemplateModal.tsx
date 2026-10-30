import { useState, type FormEvent, type ReactNode } from "react";
import { Choice } from "./Choice";
import { Modal } from "./Modal";

export interface TemplateOption {
  id: string;
  title: string;
  note?: string;
  meta?: string;
  preview?: ReactNode;
  suggested?: boolean;
}

/** Without `scratch`, the dialog opens on the list of templates. With `details`, a chosen template can be previewed. */
export function TemplateModal({
  title,
  options,
  scratch,
  templatesNote,
  apply = "Use template",
  details,
  onPick,
  onClose,
}: {
  title: string;
  options: TemplateOption[];
  scratch?: { note: string; onPick: () => void };
  templatesNote?: string;
  apply?: string;
  details?: (id: string) => ReactNode;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState(!scratch);
  const [chosen, setChosen] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const shown = options.find((o) => o.id === chosen);

  if (details && previewing && shown)
    return (
      <Modal title={shown.title} onClose={onClose} wide>
        <div className="modal-body">
          {shown.note && <p>{shown.note}</p>}
          <div className="template-options">{details(shown.id)}</div>
          <div className="modal-foot">
            <button type="button" className="btn" onClick={() => setPreviewing(false)}>
              Back
            </button>
            <button type="button" className="btn primary" onClick={() => onPick(shown.id)}>
              {apply}
            </button>
          </div>
        </div>
      </Modal>
    );

  if (scratch && !listing)
    return (
      <Modal title={title} onClose={onClose}>
        <div className="modal-body">
          <p>How do you want to start?</p>
          <div className="choice-list">
            <Choice mark="+" title="Start from scratch" note={scratch.note} onClick={scratch.onPick} />
            <Choice
              mark="⧉"
              title="Start from a template"
              note={templatesNote ?? "Kairos fills in the page. You can change everything before you save."}
              meta={options.length === 1 ? "1 template" : `${options.length} templates`}
              disabled={options.length === 0}
              onClick={() => setListing(true)}
            />
          </div>
        </div>
      </Modal>
    );

  const submit = (event: FormEvent) => (event.preventDefault(), chosen && onPick(chosen));
  return (
    <Modal title="Choose a template" onClose={onClose} wide>
      <form className="modal-body" onSubmit={submit}>
        {options.length === 0 ? (
          <p className="note">No templates yet.</p>
        ) : (
          <div className="preset-grid template-options" role="radiogroup" aria-label="Templates">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={chosen === o.id}
                className={`template-card ${chosen === o.id ? "on" : ""}`}
                onClick={() => setChosen(o.id)}
                onDoubleClick={() => onPick(o.id)}
              >
                {o.preview}
                <span className="template-card-title">
                  <b>{o.title}</b>
                  {o.suggested && <small>Suggested for this type</small>}
                </span>
                {o.note && <span className="template-card-note">{o.note}</span>}
                {o.meta && (
                  <span className="template-card-foot">
                    <small>{o.meta}</small>
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={scratch ? () => setListing(false) : onClose}>
            {scratch ? "Back" : "Cancel"}
          </button>
          {details && (
            <button type="button" className="btn" disabled={!chosen} onClick={() => setPreviewing(true)}>
              Preview
            </button>
          )}
          <button className="btn primary" disabled={!chosen}>
            {apply}
          </button>
        </div>
      </form>
    </Modal>
  );
}
