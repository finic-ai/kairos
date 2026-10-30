import { Modal } from "../ui/Modal";

export function RetentionWarning({
  from,
  to,
  onCancel,
  onConfirm,
}: {
  from: string;
  to: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={`Delete data older than ${to}?`} onClose={onCancel}>
      <div className="modal-body">
        <div className="warning-sign" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3 2 21h20L12 3Z" strokeLinejoin="round" />
            <path d="M12 10v5" strokeLinecap="round" />
            <circle cx="12" cy="18" r="0.6" fill="currentColor" />
          </svg>
        </div>
        <p>
          This workspace keeps its data <b>{from}</b> now. After you save, Kairos permanently deletes the events,
          decisions, workflow runs, webhook logs, resolved cases and inactive labels older than <b>{to}</b>, in every
          environment, Production too. The first deletion starts at the next full hour.
        </p>
        <p>This can't be undone. Changing back to Forever later does not bring back the deleted data.</p>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button type="button" className="btn danger" onClick={onConfirm}>
            Delete data older than {to}
          </button>
        </div>
      </div>
    </Modal>
  );
}
