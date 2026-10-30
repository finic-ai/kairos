/**
 * Reading files of events, entities and labels for an import: the rules the console and the
 * `kairos import` CLI use, and the same rules as the Python importer (`packages/sdk-python/src/kairos/importer.py`). A change here must be made there
 * too, so that one file is stored the same way whichever way it is imported. The tests of both
 * sides check the same cases.
 */

/** The longest id the server accepts. */
export const MAX_IMPORT_ID = 256;
/** Rows in one request: the server's limit for `PUT /v1/objects`. */
export const IMPORT_BATCH = 500;

// A cell that is a plain number. Not one with a leading zero ("02139" is a code, not 2139), and
// not a long one (a card or an account number is an identifier, and a number would change it).
const NUMBER = /^-?(0|[1-9][0-9]{0,14})(\.[0-9]+)?$/;

export interface ImportRow {
  /** The line of the file the row starts on. The first data row of a CSV file is line 2. */
  line: number;
  values: Record<string, unknown>;
  /** Why the row cannot be used at all: a line that is not JSON, or more cells than the header. */
  broken?: string;
}

export interface ParsedFile {
  columns: string[];
  rows: ImportRow[];
}

export interface CsvReader {
  /** The rows that the text completes. Text may end anywhere, also inside a quoted cell. */
  push(text: string): ImportRow[];
  /** The last row, when the file does not end with a line break. */
  end(): ImportRow[];
  /** The names from the header, once it is read. */
  columns(): string[] | undefined;
}

/**
 * A CSV reader that takes a file in parts, so that a large file does not have to be in memory.
 * Quoted cells may hold the delimiter, a doubled quote and a line break. A byte-order mark is
 * dropped. Empty lines are skipped. Every value is text.
 */
export function csvReader(delimiter = ","): CsvReader {
  let header: string[] | undefined;
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  // A quote inside a quoted cell: the end of the cell, or the first of a doubled quote.
  let quote = false;
  // A carriage return: a line break, and a line feed after it is part of the same one.
  let cr = false;
  let first = true;
  let line = 1;
  let start = 1;

  const endRecord = (out: ImportRow[]) => {
    cells.push(cell);
    const record = cells;
    cells = [];
    cell = "";
    // A line with nothing on it is not a row.
    if (record.length === 1 && record[0] === "") return;
    if (!header) {
      header = record.map((name) => name.trim());
      return;
    }
    const columns = header;
    out.push({
      line: start,
      values: Object.fromEntries(columns.map((name, k) => [name, record[k] ?? ""])),
      ...(record.length > columns.length ? { broken: "the row has more cells than the header" } : {}),
    });
  };

  return {
    push(text) {
      const out: ImportRow[] = [];
      let i = 0;
      if (first && text.length > 0) {
        first = false;
        if (text.charCodeAt(0) === 0xfeff) i = 1;
      }
      for (; i < text.length; i++) {
        const c = text[i]!;
        if (cr) {
          cr = false;
          if (c === "\n") continue;
        }
        if (quote) {
          quote = false;
          if (c === '"') {
            cell += '"';
            continue;
          }
          quoted = false;
        }
        if (quoted) {
          if (c === '"') quote = true;
          else {
            if (c === "\n") line++;
            cell += c;
          }
          continue;
        }
        if (c === '"' && cell === "") quoted = true;
        else if (c === delimiter) {
          cells.push(cell);
          cell = "";
        } else if (c === "\n" || c === "\r") {
          cr = c === "\r";
          endRecord(out);
          line++;
          start = line;
        } else cell += c;
      }
      return out;
    },
    end() {
      const out: ImportRow[] = [];
      if (cell !== "" || cells.length > 0) endRecord(out);
      return out;
    },
    columns: () => header,
  };
}

/** A CSV file as rows of named values. See `csvReader`. */
export function parseCsv(text: string, delimiter = ","): ParsedFile {
  const reader = csvReader(delimiter);
  const rows = [...reader.push(text), ...reader.end()];
  return { columns: reader.columns() ?? [], rows };
}

/** An empty line is no row. */
export function jsonLine(raw: string, line: number): ImportRow | undefined {
  if (!raw.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return { line, values: {}, broken: "not a JSON object" };
    return { line, values: value as Record<string, unknown> };
  } catch (error) {
    return { line, values: {}, broken: `not JSON: ${(error as Error).message}` };
  }
}

/** A JSON-lines file: one JSON object on each line. The columns are every key seen, in the order first seen. */
export function parseJsonLines(text: string): ParsedFile {
  const columns: string[] = [];
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const row = jsonLine(raw, index + 1);
    if (!row) return;
    for (const key of Object.keys(row.values)) if (!seen.has(key)) (seen.add(key), columns.push(key));
    rows.push(row);
  });
  return { columns, rows };
}

/** Whether a file is JSON lines, by its name: `.jsonl`, `.ndjson` and `.json`. Anything else is CSV. */
export const isJsonLines = (name: string) => /\.(jsonl|ndjson|json)$/i.test(name);

/** The file as rows, by its name: `.jsonl`, `.ndjson` and `.json` are JSON lines, anything else is CSV. */
export function parseImportFile(name: string, text: string, delimiter = ","): ParsedFile {
  return isJsonLines(name) ? parseJsonLines(text) : parseCsv(text, delimiter);
}

/**
 * A value as Kairos should store it. Empty text is no value. With `typed`, plain numbers and
 * true/false in text get their type. A value that is not text (from JSON) is kept as it is.
 */
export function importValue(raw: unknown, typed = true): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (text === "") return undefined;
  if (!typed) return text;
  if (NUMBER.test(text)) return Number(text);
  const lower = text.toLowerCase();
  if (lower === "true" || lower === "false") return lower === "true";
  return text;
}

export interface EntityImportMapping {
  type: string;
  /** The column with the entity's id. */
  id: string;
  /** Only these columns become properties. Default: every column but the id. */
  include?: string[];
  /** Columns that never become properties. */
  exclude?: string[];
  /** Columns kept as text, also when they look like numbers. */
  text?: string[];
  /** Read plain numbers and true/false in text as such. Default true. */
  typed?: boolean;
}

export type EntityImportResult =
  | { ok: true; entity: { type: string; id: string; properties: Record<string, unknown> } }
  | { ok: false; reason: string };

export function entityFromRow(row: ImportRow, mapping: EntityImportMapping): EntityImportResult {
  if (row.broken) return { ok: false, reason: row.broken };
  const raw = row.values[mapping.id];
  const id = raw === null || raw === undefined || typeof raw === "object" ? "" : String(raw).trim();
  if (!id) return { ok: false, reason: "no id" };
  if (id.length > MAX_IMPORT_ID) return { ok: false, reason: `the id is longer than ${MAX_IMPORT_ID} characters` };
  const properties: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row.values)) {
    if (column === mapping.id || mapping.exclude?.includes(column)) continue;
    if (mapping.include && !mapping.include.includes(column)) continue;
    const stored = importValue(value, (mapping.typed ?? true) && !mapping.text?.includes(column));
    if (stored !== undefined) properties[column] = stored;
  }
  return { ok: true, entity: { type: mapping.type, id, properties } };
}

export function suggestIdColumn(columns: string[], type: string): string | undefined {
  const lower = columns.map((c) => c.toLowerCase());
  const camel = type.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  for (const wanted of [`${type}_id`, `${camel}id`, "id", `${type}`]) {
    const at = lower.indexOf(wanted.toLowerCase());
    if (at >= 0) return columns[at];
  }
  return columns.find((c) => /(_id|Id)$/.test(c)) ?? columns[0];
}

/** The server's rule for the names of entity types and labels. */
export const IMPORT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_TYPE = 128;
const MAX_STATUS = 64;
const MAX_LABEL = 64;

/** A row that cannot be imported. The import writes it to the rejects file and continues. */
class RowError extends Error {}

/** SHA-256 of UTF-8 text, as hex. Given by the caller: a browser and Node.js make it differently. */
export type Sha256 = (text: string) => string;

/** user_id → user, bank_account_id → bank_account, bankAccountId → bank_account. */
export function entityTypeOfColumn(column: string): string | undefined {
  const match = /^(.+?)(?:Id|_id)$/.exec(column);
  return match ? match[1]!.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase() : undefined;
}

const present = (raw: unknown) => raw !== null && raw !== undefined && raw !== "";
const filled = (raw: unknown) => raw !== null && raw !== undefined && String(raw).trim() !== "";

function text(raw: unknown, what: string, limit: number): string {
  const value =
    raw === null || raw === undefined || typeof raw === "boolean" || typeof raw === "object" ? "" : String(raw).trim();
  if (!value) throw new RowError(`no ${what}`);
  // Characters, not UTF-16 units, as the server and the Python importer count them.
  if ([...value].length > limit) throw new RowError(`the ${what} is longer than ${limit} characters`);
  return value;
}

/** The text Python's `json.dumps(row, sort_keys=True)` makes, so that a row gets the same id from both importers. */
function pythonJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string")
    return JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${pythonJson(key)}: ${pythonJson(record[key])}`)
      .join(", ")}}`;
  }
  return pythonJson(String(value));
}

/** An id for a row with none: the same row gives the same id, so a second run stores nothing twice. */
export const importRowId = (values: Record<string, unknown>, sha256: Sha256) =>
  `imp_${sha256(pythonJson(values)).slice(0, 32)}`;

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:.(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d+)?)?)?)?)?$/i;
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const daysIn = (year: number, month: number) =>
  new Date(Date.UTC(2000, month, 0)).getUTCDate() - (month === 2 && !leap(year) ? 1 : 0);
const leap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Milliseconds since 1970 of a UTC moment, or undefined when a part is out of range. */
function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number | undefined {
  if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59)
    return undefined;
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, ms);
  return date.getTime();
}

/** `+02:00`, `-0530`, `+02`, `Z` as milliseconds to subtract. */
function offset(zone: string | undefined): number | undefined {
  if (!zone || zone.toUpperCase() === "Z") return 0;
  const match = /^([+-])(\d{2}):?(\d{2})?:?(\d{2})?(?:\.(\d+))?$/.exec(zone);
  if (!match) return undefined;
  const [, sign, h, m = "0", s = "0", f = "0"] = match;
  if (Number(h) > 23 || Number(m) > 59 || Number(s) > 59) return undefined;
  const ms = ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(`0.${f}`) * 1000;
  return sign === "-" ? -ms : ms;
}

/** Python's `datetime.fromisoformat`, with a date alone read as midnight. */
function parseIso(value: string): number | undefined {
  const match = ISO.exec(/[Zz]$/.test(value) ? `${value.slice(0, -1)}+00:00` : value);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s, fraction, zone] = match;
  const ms = fraction ? Number(fraction.slice(0, 3).padEnd(3, "0")) : 0;
  const local = utc(Number(y), Number(mo), Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0), ms);
  const shift = offset(zone);
  return local === undefined || shift === undefined ? undefined : local - shift;
}

const STRPTIME: Record<string, string> = {
  Y: "(\\d{4})",
  y: "(\\d{2})",
  m: "(1[0-2]|0[1-9]|[1-9])",
  d: "(3[01]|[12]\\d|0[1-9]|[1-9]| [1-9])",
  H: "(2[0-3]|[01]\\d|\\d)",
  I: "(1[0-2]|0[1-9]|[1-9])",
  M: "([0-5]\\d|\\d)",
  S: "(6[01]|[0-5]\\d|\\d)",
  f: "(\\d{1,6})",
  p: "(am|pm)",
  b: `(${MONTHS.map((m) => m.slice(0, 3)).join("|")})`,
  h: `(${MONTHS.map((m) => m.slice(0, 3)).join("|")})`,
  B: `(${MONTHS.join("|")})`,
  a: `(${DAYS.map((d) => d.slice(0, 3)).join("|")})`,
  A: `(${DAYS.join("|")})`,
  j: "(36[0-6]|3[0-5]\\d|[12]\\d\\d|0[1-9]\\d|00[1-9]|[1-9]\\d|0[1-9]|[1-9])",
  z: "(Z|[+-]\\d{2}:?[0-5]\\d(?::?[0-5]\\d(?:\\.\\d{1,6})?)?)",
  Z: "(utc|gmt)",
};

/** A `strptime` pattern as a regular expression and the directive of each group, or the problem with it. */
function strptimePattern(format: string): { regex: RegExp; parts: string[] } | string {
  const parts: string[] = [];
  let source = "";
  for (let i = 0; i < format.length; i++) {
    const c = format[i]!;
    if (c === "%") {
      const directive = format[++i];
      if (directive === "%") source += "%";
      else if (directive && STRPTIME[directive]) {
        source += STRPTIME[directive];
        parts.push(directive);
      } else return `%${directive ?? ""} is not a directive that the importer reads`;
    } else if (/\s/.test(c)) {
      source += "\\s+";
      while (/\s/.test(format[i + 1] ?? "")) i++;
    } else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return { regex: new RegExp(`^${source}$`, "i"), parts };
}

/** Python's `datetime.strptime`. A time with no zone is UTC. */
function strptime(value: string, format: string): number | undefined {
  const pattern = strptimePattern(format);
  if (typeof pattern === "string") return undefined;
  const match = pattern.regex.exec(value);
  if (!match) return undefined;
  let [year, month, day, hour, minute, second, ms, shift] = [1900, 1, 1, 0, 0, 0, 0, 0];
  let hour12: number | undefined;
  let pm: boolean | undefined;
  let yearDay: number | undefined;
  pattern.parts.forEach((part, k) => {
    const raw = match[k + 1]!;
    const lower = raw.toLowerCase();
    if (part === "Y") year = Number(raw);
    else if (part === "y") year = Number(raw) + (Number(raw) <= 68 ? 2000 : 1900);
    else if (part === "m") month = Number(raw);
    else if (part === "d") day = Number(raw);
    else if (part === "H") hour = Number(raw);
    else if (part === "I") hour12 = Number(raw);
    else if (part === "M") minute = Number(raw);
    else if (part === "S") second = Number(raw);
    else if (part === "f") ms = Number(raw.padEnd(6, "0").slice(0, 3));
    else if (part === "p") pm = lower === "pm";
    else if (part === "b" || part === "h") month = MONTHS.findIndex((m) => m.startsWith(lower)) + 1;
    else if (part === "B") month = MONTHS.indexOf(lower) + 1;
    else if (part === "j") yearDay = Number(raw);
    else if (part === "z") shift = offset(raw) ?? NaN;
  });
  if (hour12 !== undefined) hour = (hour12 % 12) + (pm ? 12 : 0);
  if (yearDay !== undefined && !pattern.parts.includes("m") && !pattern.parts.includes("d")) {
    const start = utc(year, 1, 1);
    if (start === undefined || yearDay > (leap(year) ? 366 : 365)) return undefined;
    const date = new Date(start + (yearDay - 1) * 86_400_000);
    month = date.getUTCMonth() + 1;
    day = date.getUTCDate();
  }
  const local = utc(year, month, day, hour, minute, second, ms);
  return local === undefined || Number.isNaN(shift) ? undefined : local - shift;
}

const UNIX = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function checkTimeFormat(format: string): string | undefined {
  if (format === "iso" || format === "unix" || format === "unix_ms") return undefined;
  if (!format.includes("%")) return `"${format}" is not a time format: use iso, unix, unix_ms or a strptime pattern`;
  const pattern = strptimePattern(format);
  return typeof pattern === "string" ? pattern : undefined;
}

/**
 * The time of a row as the API takes it: `iso` (default), `unix` (seconds), `unix_ms`, or a
 * `strptime` pattern such as `%d/%m/%Y %H:%M`. A time with no zone is UTC. Throws for a time
 * that cannot be read; `eventFromRow` and `labelFromRow` give that as the reason.
 */
export function importTime(raw: unknown, format = "iso"): string {
  if (raw === null || raw === undefined || raw === "") throw new RowError("no time");
  let ms: number | undefined;
  if (format === "unix" || format === "unix_ms") {
    const value =
      typeof raw === "number" ? raw : typeof raw === "string" && UNIX.test(raw.trim()) ? Number(raw.trim()) : NaN;
    // As Python does: to the microsecond first, then down to the millisecond.
    if (Number.isFinite(value)) ms = Math.floor(Math.round(format === "unix" ? value * 1e6 : value * 1e3) / 1000);
  } else {
    const value = String(raw).trim();
    ms = format === "iso" ? parseIso(value) : strptime(value, format);
  }
  const date = ms === undefined ? undefined : new Date(ms);
  if (!date || Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999)
    throw new RowError(`"${String(raw)}" is not a time${format === "iso" ? "" : ` in the form ${format}`}`);
  return date.toISOString();
}

interface Properties {
  /** Only these columns become properties. Default: every column not used otherwise. */
  include?: string[];
  /** Columns that never become properties. */
  exclude?: string[];
  /** Columns kept as text, also when they look like numbers. */
  text?: string[];
  /** Read plain numbers and true/false in text as such. Default true. */
  typed?: boolean;
}

function property(mapping: Properties, column: string, raw: unknown, into: Record<string, unknown>): void {
  if (mapping.include && !mapping.include.includes(column)) return;
  const stored = importValue(raw, (mapping.typed ?? true) && !mapping.text?.includes(column));
  if (stored !== undefined) into[column] = stored;
}

function attempt<T>(build: () => T): { ok: true; value: T } | { ok: false; reason: string } {
  try {
    return { ok: true, value: build() };
  } catch (error) {
    if (error instanceof RowError) return { ok: false, reason: error.message };
    throw error;
  }
}

export interface EventImportMapping extends Properties {
  /** The event type of every row. Give this or `typeColumn`. */
  type?: string;
  typeColumn?: string;
  /** The column with the time the event happened. Necessary: history has its own times. */
  ts?: string;
  tsFormat?: string;
  /** The column with a unique id for the event. Without it, the id is a hash of the row. */
  id?: string;
  /** Entity type → column, for columns that do not end in `_id`: `{ user: "customer" }`. */
  entities?: Record<string, string>;
  /** Columns that end in `_id` name an entity, as in the SDK. Default true. */
  autoEntities?: boolean;
  universalId?: string;
  status?: string;
  session?: string;
}

export interface ImportedEvent {
  id: string;
  type: string;
  ts: string;
  entities: Record<string, string>;
  properties: Record<string, unknown>;
  universal_id?: string;
  status?: string;
  session?: string;
}

/** The problem with a mapping, before any row is read. */
export function checkEventMapping(mapping: EventImportMapping): string | undefined {
  if (!mapping.type === !mapping.typeColumn)
    return "Give the event type of the file (--type) or the column that holds it (--type-column), not both and not neither";
  if (mapping.type && mapping.type.length > MAX_TYPE) return `The event type is longer than ${MAX_TYPE} characters`;
  if (!mapping.ts)
    return "Name the column with the time of each event (--ts). Without it, every event would have the time of the import.";
  for (const kind of Object.keys(mapping.entities ?? {}))
    if (!IMPORT_NAME.test(kind))
      return `"${kind}" is not an entity type: use letters, digits and underscores, starting with a letter`;
  return checkTimeFormat(mapping.tsFormat ?? "iso");
}

export type EventImportResult = { ok: true; event: ImportedEvent } | { ok: false; reason: string };

export function eventFromRow(row: ImportRow, mapping: EventImportMapping, sha256: Sha256): EventImportResult {
  const result = attempt(() => {
    if (row.broken) throw new RowError(row.broken);
    const values = row.values;
    const named = mapping.entities ?? {};
    const used = new Set(
      [
        mapping.typeColumn,
        mapping.ts,
        mapping.id,
        mapping.universalId,
        mapping.status,
        mapping.session,
        ...Object.values(named),
      ].filter((column): column is string => !!column),
    );
    const entities: Record<string, string> = {};
    for (const [kind, column] of Object.entries(named))
      if (filled(values[column])) entities[kind] = text(values[column], `${kind} id`, MAX_IMPORT_ID);
    const properties: Record<string, unknown> = {};
    for (const [column, raw] of Object.entries(values)) {
      if (used.has(column) || mapping.exclude?.includes(column)) continue;
      const kind = mapping.autoEntities === false ? undefined : entityTypeOfColumn(column);
      if (kind && IMPORT_NAME.test(kind) && filled(raw) && typeof raw !== "object" && typeof raw !== "boolean") {
        const id = text(raw, `${kind} id`, MAX_IMPORT_ID);
        entities[kind] ??= id;
        continue;
      }
      property(mapping, column, raw, properties);
    }
    if (Object.keys(entities).length === 0)
      throw new RowError("the row names no entity: map a column with --entity, or name one ending in _id");
    const event: ImportedEvent = {
      id: mapping.id ? text(values[mapping.id], "id", MAX_IMPORT_ID) : importRowId(values, sha256),
      type: mapping.type || text(values[mapping.typeColumn ?? ""], "event type", MAX_TYPE),
      ts: importTime(values[mapping.ts ?? ""], mapping.tsFormat),
      entities,
      properties,
    };
    if (mapping.universalId && present(values[mapping.universalId]))
      event.universal_id = text(values[mapping.universalId], "universal id", MAX_IMPORT_ID);
    if (mapping.status && present(values[mapping.status]))
      event.status = text(values[mapping.status], "status", MAX_STATUS);
    if (mapping.session && present(values[mapping.session]))
      event.session = text(values[mapping.session], "session", MAX_IMPORT_ID);
    return event;
  });
  return result.ok ? { ok: true, event: result.value } : result;
}

export interface LabelImportMapping extends Properties {
  /** The type of the entity the label is on. */
  entityType: string;
  /** The column with its id. */
  entity: string;
  /** The label of every row, for example `fraud_confirmed`. Give this or `labelColumn`. */
  label?: string;
  labelColumn?: string;
  /** The column with the time the outcome became known. Without it, the time of the import. */
  ts?: string;
  tsFormat?: string;
}

export interface ImportedLabel {
  entity: { type: string; id: string };
  label: string;
  properties: Record<string, unknown>;
  ts?: string;
}

export function checkLabelMapping(mapping: LabelImportMapping): string | undefined {
  if (!IMPORT_NAME.test(mapping.entityType)) return `"${mapping.entityType}" is not an entity type`;
  if (!mapping.label === !mapping.labelColumn)
    return "Give the label of the file (--label) or the column that holds it (--label-column), not both and not neither";
  if (mapping.label && !IMPORT_NAME.test(mapping.label))
    return `"${mapping.label}" is not a label: use letters, digits and underscores, starting with a letter`;
  return checkTimeFormat(mapping.tsFormat ?? "iso");
}

export type LabelImportResult = { ok: true; label: ImportedLabel } | { ok: false; reason: string };

export function labelFromRow(row: ImportRow, mapping: LabelImportMapping): LabelImportResult {
  const result = attempt(() => {
    if (row.broken) throw new RowError(row.broken);
    const values = row.values;
    const label = mapping.label || text(values[mapping.labelColumn ?? ""], "label", MAX_LABEL);
    if (!IMPORT_NAME.test(label))
      throw new RowError(`"${label}" is not a label: use letters, digits and underscores, starting with a letter`);
    const used = new Set([mapping.entity, mapping.labelColumn, mapping.ts].filter(Boolean));
    const properties: Record<string, unknown> = {};
    for (const [column, raw] of Object.entries(values))
      if (!used.has(column) && !mapping.exclude?.includes(column)) property(mapping, column, raw, properties);
    const item: ImportedLabel = {
      entity: { type: mapping.entityType, id: text(values[mapping.entity], `${mapping.entityType} id`, MAX_IMPORT_ID) },
      label,
      properties,
    };
    if (mapping.ts) item.ts = importTime(values[mapping.ts], mapping.tsFormat);
    return item;
  });
  return result.ok ? { ok: true, label: result.value } : result;
}

export function checkEntityMapping(mapping: EntityImportMapping): string | undefined {
  if (!IMPORT_NAME.test(mapping.type))
    return `"${mapping.type}" is not an entity type: use letters, digits and underscores, starting with a letter`;
  return undefined;
}
