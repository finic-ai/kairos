import type { PropertyFormat } from "@kairos/core";
import { useEffect, useState } from "react";
import { api } from "../../api/index";
import { ApiError } from "../../api/client";
import { useApi } from "../../hooks/useApi";
import { cellText } from "../../lib/facts";
import { IMAGE_TYPES, openFile } from "../../lib/files";
import { valueText } from "../../lib/format";
import { Modal } from "../ui/Modal";
import type { EntityRef } from "../../types/interfaces";

const problemOf = (error: unknown) =>
  error instanceof ApiError && error.status === 410
    ? "The link has expired."
    : error instanceof ApiError && error.status === 403
      ? "Its host is not approved. An admin can approve it in Settings › Workspace."
      : (error as Error).message;

function ImageModal({ entity, name, onClose }: { entity: EntityRef; name: string; onClose: () => void }) {
  const { data: blob, error } = useApi(["entity-media", entity.type, entity.id, name], () =>
    api.entityMedia(entity, name),
  );
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob || !IMAGE_TYPES.includes(blob.type)) return;
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return (
    <Modal title={name[0]!.toUpperCase() + name.slice(1).replaceAll("_", " ")} onClose={onClose} wide>
      <div className="modal-body image-modal">
        {error ? (
          <span className="muted">{problemOf(error)}</span>
        ) : url ? (
          <img src={url} alt={name.replaceAll("_", " ")} />
        ) : (
          <span className="muted">Loading…</span>
        )}
      </div>
    </Modal>
  );
}

function ImageValue({ entity, name }: { entity: EntityRef; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn compact" onClick={() => setOpen(true)}>
        View image
      </button>
      {open && <ImageModal entity={entity} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

function DocumentValue({ entity, name }: { entity: EntityRef; name: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const open = async () => {
    const tab = window.open("", "_blank");
    try {
      openFile(await api.entityMedia(entity, name), name, tab);
    } catch (e) {
      tab?.close();
      setProblem(problemOf(e));
    }
  };
  return problem ? (
    <span className="muted">{problem}</span>
  ) : (
    <button type="button" className="btn compact" onClick={open}>
      Open
    </button>
  );
}

/** One property of an entity, as its type's format says: an image, a document, a link, money. */
export function PropertyValue({
  entity,
  name,
  value,
  format,
}: {
  entity: EntityRef;
  name: string;
  value: unknown;
  format: PropertyFormat | undefined;
}) {
  if (format === "image") return <ImageValue entity={entity} name={name} />;
  if (format === "document") return <DocumentValue entity={entity} name={name} />;
  if (format === "link" && typeof value === "string" && /^https?:\/\//i.test(value))
    return (
      <a className="linkish" href={value} target="_blank" rel="noreferrer noopener">
        {new URL(value).hostname}
      </a>
    );
  if (format && format !== "link") return <>{cellText({ field: name, label: name, format }, { [name]: value })}</>;
  return <>{valueText(value)}</>;
}
