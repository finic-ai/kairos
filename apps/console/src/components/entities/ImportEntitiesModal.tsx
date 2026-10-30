import { useMemo, useRef, useState } from "react";
import {
  entityFromRow,
  IMPORT_BATCH,
  parseImportFile,
  suggestIdColumn,
  EntityImportMapping,
  ImportRow,
  ParsedFile,
} from "@kairos/core";
import { api, ApiError } from "../../api/index";
import { Modal } from "../ui/Modal";
import { entityName, entityNames } from "../../lib/format";

/** A browser reads a file of this size well. A larger one belongs to the command-line import. */
const MAX_BYTES = 50 * 1024 * 1024;
const DELIMITERS: [string, string][] = [
  [",", "Comma"],
  [";", "Semicolon"],
  ["\t", "Tab"],
  ["|", "Pipe"],
];

type Entity = { type: string; id: string; properties: Record<string, unknown> };
type Rejected = { line: number; reason: string; values: Record<string, unknown> };
type Step =
  | { at: "choose" }
  | { at: "map"; name: string; text: string; size: number }
  | {
      at: "send";
      name: string;
      columns: string[];
      done: number;
      total: number;
      stored: number;
      entities: number;
      rejected: Rejected[];
      stopped?: string;
      finished: boolean;
      cancelled: boolean;
    };

const shown = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
const count = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const bytes = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${Number((n / 1024 / 1024).toFixed(1))} MB`;

function rejectsCsv(rejected: Rejected[], columns: string[]): string {
  const cell = (value: unknown) => {
    const text = value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return (
    [
      ["line", "reason", ...columns].map(cell).join(","),
      ...rejected.map((r) => [r.line, r.reason, ...columns.map((c) => r.values[c])].map(cell).join(",")),
    ].join("\n") + "\n"
  );
}

/**
 * Upload a file of entities of one type: what is known about each customer, merchant or device.
 * The file is read in the browser and sent in batches of 500 with the person's own session.
 * The rules are those of the Python importer, so a file is stored the same way either way.
 */
export function ImportEntitiesModal({
  type,
  onClose,
  onDone,
}: {
  type: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>({ at: "choose" });
  const [error, setError] = useState<string | null>(null);
  const [delimiter, setDelimiter] = useState(",");
  const [idColumn, setIdColumn] = useState("");
  const [skipped, setSkipped] = useState<string[]>([]);
  const [asText, setAsText] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const cancel = useRef(false);

  const file = step.at === "map" ? step : null;
  const parsed: ParsedFile | null = useMemo(
    () => (file ? parseImportFile(file.name, file.text, delimiter) : null),
    [file?.text, file?.name, delimiter],
  );
  const mapping: EntityImportMapping = { type, id: idColumn, exclude: skipped, text: asText };
  const results = useMemo(
    () => (parsed && idColumn ? parsed.rows.map((row) => ({ row, result: entityFromRow(row, mapping) })) : []),
    [parsed, idColumn, skipped, asText],
  );
  const good = results.filter((r) => r.result.ok).length;
  const bad = results.filter((r) => !r.result.ok);
  // Two rows with the same id are merged by the server, the later one winning. Say so before.
  const repeated = useMemo(() => {
    const seen = new Set<string>();
    let n = 0;
    for (const { result } of results) if (result.ok) seen.has(result.entity.id) ? n++ : seen.add(result.entity.id);
    return n;
  }, [results]);

  const read = async (chosen: File | undefined) => {
    setError(null);
    if (!chosen) return;
    if (chosen.size > MAX_BYTES)
      return setError(
        `This file is ${bytes(chosen.size)}. The console reads files up to ${bytes(MAX_BYTES)}. Use the command-line import for a larger one.`,
      );
    const text = await chosen.text();
    const first = parseImportFile(chosen.name, text, ",");
    const guess =
      first.columns.length === 1
        ? (DELIMITERS.find(([d]) => d !== "," && first.columns[0]!.includes(d))?.[0] ?? ",")
        : ",";
    const columns = parseImportFile(chosen.name, text, guess).columns;
    if (columns.length === 0) return setError("This file has no header row. The first line must name the columns.");
    setDelimiter(guess);
    setIdColumn(suggestIdColumn(columns, type) ?? "");
    setSkipped([]);
    setAsText([]);
    setStep({ at: "map", name: chosen.name, text, size: chosen.size });
  };

  const send = async () => {
    if (!parsed) return;
    cancel.current = false;
    const rejected: Rejected[] = bad.map(({ row, result }) => ({
      line: row.line,
      reason: result.ok ? "" : result.reason,
      values: row.values,
    }));
    const items = results.flatMap(({ row, result }) => (result.ok ? [{ row, entity: result.entity }] : []));
    let state: Extract<Step, { at: "send" }> = {
      at: "send",
      name: file?.name ?? "import",
      columns: parsed.columns,
      done: 0,
      total: items.length,
      stored: 0,
      entities: 0,
      rejected,
      finished: false,
      cancelled: false,
    };
    // Two rows with one id are one entity: the result counts entities, and rows only when they differ.
    const storedIds = new Set<string>();
    setStep(state);
    const update = (patch: Partial<typeof state>) => setStep((state = { ...state, ...patch }));

    // A batch the server refuses is sent again in halves, so that one bad row costs only itself.
    const put = async (part: { row: ImportRow; entity: Entity }[]): Promise<void> => {
      try {
        const answer = await api.saveEntities(part.map((p) => p.entity));
        for (const p of part) storedIds.add(p.entity.id);
        update({ stored: state.stored + (answer.accepted ?? part.length), entities: storedIds.size });
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 400) throw e;
        if (part.length === 1) {
          update({
            rejected: [
              ...state.rejected,
              { line: part[0]!.row.line, reason: `the server refused it: ${e.message}`, values: part[0]!.row.values },
            ],
          });
          return;
        }
        const middle = Math.floor(part.length / 2);
        await put(part.slice(0, middle));
        await put(part.slice(middle));
      }
    };
    try {
      for (let i = 0; i < items.length; i += IMPORT_BATCH) {
        if (cancel.current) return update({ cancelled: true, finished: true });
        const part = items.slice(i, i + IMPORT_BATCH);
        await put(part);
        update({ done: Math.min(items.length, i + part.length) });
      }
      update({ finished: true });
    } catch (e) {
      update({ finished: true, stopped: (e as Error).message });
    } finally {
      onDone();
    }
  };

  const download = ({ rejected, columns, name }: Extract<Step, { at: "send" }>) => {
    const url = URL.createObjectURL(new Blob([rejectsCsv(rejected, columns)], { type: "text/csv" }));
    const link = Object.assign(document.createElement("a"), {
      href: url,
      download: `${name.replace(/\.[^.]+$/, "")}-rejected.csv`,
    });
    link.click();
    URL.revokeObjectURL(url);
  };

  const sending = step.at === "send" && !step.finished;
  return (
    <Modal
      title={`Import ${entityNames(type).toLowerCase()}`}
      onClose={() => (sending ? (cancel.current = true) : onClose())}
      wide={step.at === "map"}
    >
      <div className="modal-body import">
        {error && (
          <div className="banner" style={{ margin: 0 }}>
            {error}
          </div>
        )}

        {step.at === "choose" && (
          <>
            <p>
              Upload what you know about your {entityNames(type).toLowerCase()}: one row for each{" "}
              {entityName(type).toLowerCase()}, with its id and its properties. Properties are merged into what is
              stored, so a second file adds to the first.
            </p>
            <label
              className={`dropzone ${dragging ? "over" : ""}`}
              onDragOver={(e) => (e.preventDefault(), setDragging(true))}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => (e.preventDefault(), setDragging(false), void read(e.dataTransfer.files[0]))}
            >
              <input
                type="file"
                accept=".csv,.tsv,.txt,.jsonl,.ndjson,.json"
                onChange={(e) => void read(e.target.files?.[0])}
              />
              <b>Choose a file</b>
              <span>or drop it here. CSV, or JSON lines (one object on each line). Up to {bytes(MAX_BYTES)}.</span>
            </label>
            <p className="note" style={{ margin: 0 }}>
              The first row of a CSV file names the columns. Nothing is sent until you check the preview and choose
              Import.
            </p>
          </>
        )}

        {step.at === "map" && parsed && (
          <>
            <div className="import-file">
              <span className="mono">{step.name}</span>
              <span className="muted">
                {bytes(step.size)} · {parsed.rows.length.toLocaleString()} rows · {parsed.columns.length} columns
              </span>
              <button type="button" className="btn ghost" onClick={() => setStep({ at: "choose" })}>
                Choose another file
              </button>
            </div>
            <div className="import-grid">
              <div className="stack" style={{ gap: 14 }}>
                <label className="field">
                  <span>Which column is the id?</span>
                  <select
                    className="input mono"
                    value={idColumn}
                    onChange={(e) => (
                      setIdColumn(e.target.value),
                      setSkipped(skipped.filter((c) => c !== e.target.value))
                    )}
                  >
                    {parsed.columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <small>
                    Use the same id as your events and decisions, or the properties land on a different{" "}
                    {entityName(type).toLowerCase()}.
                  </small>
                </label>
                {!/\.(jsonl|ndjson|json)$/i.test(step.name) && (
                  <label className="field">
                    <span>Columns are separated by</span>
                    <select className="input" value={delimiter} onChange={(e) => setDelimiter(e.target.value)}>
                      {DELIMITERS.map(([d, label]) => (
                        <option key={label} value={d}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="field">
                  <span>Properties</span>
                  <div className="import-columns">
                    {parsed.columns
                      .filter((c) => c !== idColumn)
                      .map((c) => (
                        <div key={c}>
                          <label>
                            <input
                              type="checkbox"
                              checked={!skipped.includes(c)}
                              onChange={() =>
                                setSkipped(skipped.includes(c) ? skipped.filter((s) => s !== c) : [...skipped, c])
                              }
                            />
                            <span className="mono">{c}</span>
                          </label>
                          <label
                            className="muted"
                            title="Keep the values as text, also when they look like numbers: postcodes, phone numbers."
                          >
                            <input
                              type="checkbox"
                              disabled={skipped.includes(c)}
                              checked={asText.includes(c)}
                              onChange={() =>
                                setAsText(asText.includes(c) ? asText.filter((s) => s !== c) : [...asText, c])
                              }
                            />
                            text
                          </label>
                        </div>
                      ))}
                  </div>
                  <small>
                    Numbers and true/false become values of their own type, except a number with a leading zero and a
                    very long one, which stay text.
                  </small>
                </div>
              </div>

              <div className="stack" style={{ gap: 12, minWidth: 0 }}>
                <div className="import-counts">
                  <div>
                    <b>{good.toLocaleString()}</b>
                    <span>to import</span>
                  </div>
                  <div className={bad.length ? "warn" : ""}>
                    <b>{bad.length.toLocaleString()}</b>
                    <span>cannot be used</span>
                  </div>
                </div>
                {repeated > 0 && (
                  <p className="note" style={{ margin: 0 }}>
                    {count(repeated, "row repeats", "rows repeat")} an id that comes earlier in the file. The properties
                    are merged, and the later row wins.
                  </p>
                )}
                <div className="sub-title">The first rows, as they will be stored</div>
                <div className="import-preview">
                  {results.slice(0, 6).map(({ row, result }) => (
                    <div key={row.line} className={result.ok ? "" : "bad"}>
                      <span className="mono muted">line {row.line}</span>
                      {result.ok ? (
                        <>
                          <span className="mono">{result.entity.id}</span>
                          <span className="import-props">
                            {Object.entries(result.entity.properties).map(([k, v]) => (
                              <span key={k}>
                                <i>{k}</i>{" "}
                                <span className={`mono ${typeof v === "string" ? "" : "typed"}`}>{shown(v)}</span>
                              </span>
                            ))}
                            {Object.keys(result.entity.properties).length === 0 && (
                              <span className="muted">no properties</span>
                            )}
                          </span>
                        </>
                      ) : (
                        <span className="import-reason">{result.reason}</span>
                      )}
                    </div>
                  ))}
                </div>
                {bad.length > 0 && (
                  <div className="import-problems">
                    <div className="sub-title">Rows that cannot be used</div>
                    {bad.slice(0, 4).map(({ row, result }) => (
                      <div key={row.line}>
                        <span className="mono muted">line {row.line}</span> {result.ok ? "" : result.reason}
                      </div>
                    ))}
                    {bad.length > 4 && (
                      <div className="muted">
                        and {(bad.length - 4).toLocaleString()} more. You can download them all after the import.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn primary" disabled={good === 0} onClick={() => void send()}>
                Import {good.toLocaleString()}{" "}
                {good === 1 ? entityName(type).toLowerCase() : entityNames(type).toLowerCase()}
              </button>
            </div>
          </>
        )}

        {step.at === "send" && (
          <>
            <div
              className="import-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={step.total}
              aria-valuenow={step.done}
            >
              <div style={{ width: `${step.total ? (100 * step.done) / step.total : 100}%` }} />
            </div>
            <p>
              {!step.finished
                ? `Sending… ${step.done.toLocaleString()} of ${step.total.toLocaleString()}`
                : step.stopped
                  ? `The import stopped after ${count(step.entities, entityName(type).toLowerCase(), entityNames(type).toLowerCase())}: ${step.stopped}`
                  : step.cancelled
                    ? `Stopped. ${count(step.entities, entityName(type).toLowerCase(), entityNames(type).toLowerCase())} stored before that.`
                    : `${count(step.entities, entityName(type).toLowerCase(), entityNames(type).toLowerCase())} stored${step.stored !== step.entities ? `, from ${count(step.stored, "row", "rows")}` : ""}.`}
              {step.finished &&
                step.rejected.length > 0 &&
                ` ${count(step.rejected.length, "row", "rows")} could not be used.`}
            </p>
            {step.finished && (step.stopped || step.cancelled) && (
              <p className="note" style={{ margin: 0 }}>
                Import the same file again to finish: what was stored is only updated, not added twice.
              </p>
            )}
            <div className="modal-foot">
              {step.finished && step.rejected.length > 0 && (
                <button type="button" className="btn" onClick={() => download(step)}>
                  Download rejected rows
                </button>
              )}
              {sending ? (
                <button type="button" className="btn" onClick={() => (cancel.current = true)}>
                  Stop
                </button>
              ) : (
                <button type="button" className="btn primary" onClick={onClose}>
                  Done
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
