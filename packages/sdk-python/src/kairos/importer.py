"""Import history from files: events, entities and labels.

A new workspace has no history, so its first decisions have little to read. This loads what a
customer already has (transactions, logins, the customer table, chargebacks) through the normal
API. An imported event is the same as a tracked one, and an import makes no decisions.

    python -m kairos import events transactions.csv --type transaction --ts created_at --id txn_id
    python -m kairos import entities customers.csv --type user --id customer_id
    python -m kairos import labels chargebacks.csv --entity user=customer_id --label fraud_confirmed --ts reported_at

Or from Python:

    from kairos import Kairos
    from kairos.importer import EventMapping, import_events, read_rows

    with Kairos(api_key, base_url=url) as kairos:
        result = import_events(kairos, read_rows("transactions.csv"), EventMapping(type="transaction", ts="created_at", id="txn_id"))

An import can be run again: each event has an id, from a column or from a hash of the row, and the
server stores an id only once. An import that stopped is continued with the same command.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
import time
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Any, Callable

from .client import Kairos, _encode, _entity_type, _iso
from .errors import KairosApiError, KairosError

#: A row of a file, with its line number (the first data row of a CSV file is line 2).
Row = tuple[int, dict[str, Any]]

#: The server's rules, checked here so that one bad row does not cost a batch of 500.
NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
MAX_ID = 256
MAX_TYPE = 128
MAX_STATUS = 64
BATCH = 500

# A CSV cell that is a plain number. Not one with a leading zero ("00123" is a code, not 123), and
# not a long one (a card or account number is an identifier, and a float would change it).
_NUMBER = re.compile(r"^-?(0|[1-9][0-9]{0,14})(\.[0-9]+)?$")


class RowError(ValueError):
    """A row that cannot be imported. The import writes it to the rejects file and continues."""


def read_rows(path: str | Path, *, format: str | None = None, delimiter: str = ",", encoding: str = "utf-8-sig") -> Iterator[Row]:
    """The rows of a CSV or JSON-lines file, one at a time, so that a large file does not fill the memory.

    :param format: ``"csv"`` or ``"jsonl"``. Default: from the extension (``.jsonl``, ``.ndjson`` and ``.json`` are JSON lines).
    :param encoding: ``utf-8-sig`` reads plain UTF-8 too, and drops the byte-order mark that spreadsheets write.
    """
    file = Path(path)
    kind = format or ("jsonl" if file.suffix.lower() in (".jsonl", ".ndjson", ".json") else "csv")
    if kind not in ("csv", "jsonl"):
        raise KairosError(f'format must be "csv" or "jsonl", not "{kind}"')
    with file.open(encoding=encoding, newline="") as handle:
        yield from (_jsonl(handle) if kind == "jsonl" else _csv(handle, delimiter))


def _csv(handle: IO[str], delimiter: str) -> Iterator[Row]:
    reader = csv.DictReader(handle, delimiter=delimiter)
    if not reader.fieldnames:
        return
    for row in reader:
        # A row with more cells than the header puts the rest under None. That is a broken row.
        extra = row.pop(None, None)
        values: dict[str, Any] = {key.strip(): value for key, value in row.items() if key is not None}
        if extra:
            values["__extra__"] = extra
        yield reader.line_num, values


def _jsonl(handle: IO[str]) -> Iterator[Row]:
    for number, line in enumerate(handle, start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except ValueError as error:
            yield number, {"__invalid__": f"not JSON: {error}"}
            continue
        yield number, value if isinstance(value, dict) else {"__invalid__": "not a JSON object"}


def _value(raw: Any, typed: bool) -> Any:
    """A cell as Kairos should store it. Empty text is no value. In a CSV, plain numbers and true/false get their type."""
    if raw is None:
        return None
    if not isinstance(raw, str):
        return raw
    text = raw.strip()
    if text == "":
        return None
    if not typed:
        return text
    if _NUMBER.match(text):
        return float(text) if "." in text else int(text)
    if text.lower() in ("true", "false"):
        return text.lower() == "true"
    return text


def _moment(raw: Any, form: str) -> str:
    """The time of a row as the API takes it."""
    if raw is None or raw == "":
        raise RowError("no time")
    try:
        if form == "unix":
            return _iso(datetime.fromtimestamp(float(raw), timezone.utc))
        if form == "unix_ms":
            return _iso(datetime.fromtimestamp(float(raw) / 1000, timezone.utc))
        if form != "iso":
            # A strptime pattern, for example "%d/%m/%Y %H:%M". A time with no zone is UTC.
            return _iso(datetime.strptime(str(raw).strip(), form))
        text = str(raw).strip()
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
            text += "T00:00:00"
        return _iso(text)
    except (KairosError, ValueError, OverflowError, OSError):
        raise RowError(f'"{raw}" is not a time{"" if form == "iso" else f" in the form {form}"}') from None


def _text(raw: Any, what: str, limit: int) -> str:
    if raw is None or raw == "":
        raise RowError(f"no {what}")
    text = str(raw).strip() if not isinstance(raw, bool) else ""
    if not text:
        raise RowError(f"no {what}")
    if len(text) > limit:
        raise RowError(f"the {what} is longer than {limit} characters")
    return text


def _row_id(prefix: str, row: Mapping[str, Any]) -> str:
    """An id for a row with none: the same row gives the same id, so a second run stores nothing twice."""
    digest = hashlib.sha256(json.dumps(row, sort_keys=True, default=str).encode("utf-8")).hexdigest()
    return f"{prefix}_{digest[:32]}"


def _check_row(row: Mapping[str, Any]) -> None:
    if "__invalid__" in row:
        raise RowError(str(row["__invalid__"]))
    if "__extra__" in row:
        raise RowError("the row has more cells than the header")


@dataclass
class EventMapping:
    """How a row becomes an event. Every field names a column, except ``type`` and ``label``-like constants.

    :param type: The event type of every row. Give this or ``type_column``.
    :param type_column: The column that holds the event type.
    :param ts: The column with the time the event happened. Necessary: history has its own times.
    :param ts_format: ``iso`` (default), ``unix`` (seconds), ``unix_ms``, or a ``strptime`` pattern. A time with no zone is UTC.
    :param id: The column with a unique id for the event. Without it, the id is a hash of the row.
    :param entities: Entity type → column, for columns that do not end in ``_id``: ``{"user": "customer"}``.
    :param auto_entities: Columns that end in ``_id`` name an entity, as in the SDK. Default true.
    :param universal_id: The column that groups the stages of one record.
    :param status: The column with the state of the record at this stage.
    :param session: The column with the session id.
    :param include: Only these columns become properties. Default: every column not used above.
    :param exclude: Columns that never become properties.
    :param text: Columns to keep as text in a CSV, also when they look like numbers.
    :param typed: In a CSV, read plain numbers and true/false as such. Default true. JSON keeps its own types.
    """

    type: str | None = None
    type_column: str | None = None
    ts: str | None = None
    ts_format: str = "iso"
    id: str | None = None
    entities: Mapping[str, str] = field(default_factory=dict)
    auto_entities: bool = True
    universal_id: str | None = None
    status: str | None = None
    session: str | None = None
    include: Sequence[str] | None = None
    exclude: Sequence[str] = ()
    text: Sequence[str] = ()
    typed: bool = True

    def check(self) -> None:
        if bool(self.type) == bool(self.type_column):
            raise KairosError("Give the event type of the file (type) or the column that holds it (type_column), not both and not neither")
        if self.type and len(self.type) > MAX_TYPE:
            raise KairosError(f"type is longer than {MAX_TYPE} characters")
        if not self.ts:
            raise KairosError("Name the column with the time of each event (ts). Without it, every event would have the time of the import.")
        for kind in self.entities:
            if not NAME.match(kind):
                raise KairosError(f'"{kind}" is not an entity type: use letters, digits and underscores, starting with a letter')

    def event(self, row: Mapping[str, Any]) -> dict[str, Any]:
        _check_row(row)
        used = {c for c in (self.type_column, self.ts, self.id, self.universal_id, self.status, self.session) if c}
        used.update(self.entities.values())

        entities: dict[str, str] = {}
        for kind, column in self.entities.items():
            value = row.get(column)
            if value is not None and str(value).strip() != "":
                entities[kind] = _text(value, f"{kind} id", MAX_ID)
        properties: dict[str, Any] = {}
        for column, raw in row.items():
            if column in used or column in self.exclude:
                continue
            named = _entity_type(column) if self.auto_entities else None
            if named and NAME.match(named) and raw is not None and str(raw).strip() != "" and not isinstance(raw, (dict, list, bool)):
                entities.setdefault(named, _text(raw, f"{named} id", MAX_ID))
                continue
            if self.include is not None and column not in self.include:
                continue
            value = _value(raw, self.typed and column not in self.text)
            if value is not None:
                properties[column] = value
        if not entities:
            raise RowError("the row names no entity: map a column with --entity, or name one ending in _id")

        event: dict[str, Any] = {
            "id": _text(row.get(self.id), "id", MAX_ID) if self.id else _row_id("imp", row),
            "type": self.type or _text(row.get(self.type_column or ""), "event type", MAX_TYPE),
            "ts": _moment(row.get(self.ts or ""), self.ts_format),
            "entities": entities,
            "properties": properties,
        }
        if self.universal_id and row.get(self.universal_id) not in (None, ""):
            event["universal_id"] = _text(row[self.universal_id], "universal id", MAX_ID)
        if self.status and row.get(self.status) not in (None, ""):
            event["status"] = _text(row[self.status], "status", MAX_STATUS)
        if self.session and row.get(self.session) not in (None, ""):
            event["session"] = _text(row[self.session], "session", MAX_ID)
        return event


@dataclass
class EntityMapping:
    """How a row becomes what is known about one entity.

    :param type: The entity type of every row: ``user``, ``merchant``.
    :param id: The column with the entity's id.
    :param include, exclude, text, typed: As for events.
    """

    type: str
    id: str
    include: Sequence[str] | None = None
    exclude: Sequence[str] = ()
    text: Sequence[str] = ()
    typed: bool = True

    def check(self) -> None:
        if not NAME.match(self.type):
            raise KairosError(f'"{self.type}" is not an entity type: use letters, digits and underscores, starting with a letter')

    def entity(self, row: Mapping[str, Any]) -> dict[str, Any]:
        _check_row(row)
        properties: dict[str, Any] = {}
        for column, raw in row.items():
            if column == self.id or column in self.exclude or (self.include is not None and column not in self.include):
                continue
            value = _value(raw, self.typed and column not in self.text)
            if value is not None:
                properties[column] = value
        return {"type": self.type, "id": _text(row.get(self.id), "id", MAX_ID), "properties": properties}


@dataclass
class LabelMapping:
    """How a row becomes a label on an entity.

    :param entity_type: The type of the entity the label is on.
    :param entity: The column with its id.
    :param label: The label of every row, for example ``fraud_confirmed``. Give this or ``label_column``.
    :param label_column: The column that holds the label.
    :param ts: The column with the time the outcome became known. Without it, the time of the import.
    :param ts_format: As for events.
    :param include, exclude, text, typed: As for events. The other columns become the label's properties.
    """

    entity_type: str
    entity: str
    label: str | None = None
    label_column: str | None = None
    ts: str | None = None
    ts_format: str = "iso"
    include: Sequence[str] | None = None
    exclude: Sequence[str] = ()
    text: Sequence[str] = ()
    typed: bool = True

    def check(self) -> None:
        if not NAME.match(self.entity_type):
            raise KairosError(f'"{self.entity_type}" is not an entity type')
        if bool(self.label) == bool(self.label_column):
            raise KairosError("Give the label of the file (label) or the column that holds it (label_column), not both and not neither")
        if self.label and not NAME.match(self.label):
            raise KairosError(f'"{self.label}" is not a label: use letters, digits and underscores, starting with a letter')

    def item(self, row: Mapping[str, Any]) -> dict[str, Any]:
        _check_row(row)
        label = self.label or _text(row.get(self.label_column or ""), "label", 64)
        if not NAME.match(label):
            raise RowError(f'"{label}" is not a label: use letters, digits and underscores, starting with a letter')
        used = {c for c in (self.entity, self.label_column, self.ts) if c}
        properties: dict[str, Any] = {}
        for column, raw in row.items():
            if column in used or column in self.exclude or (self.include is not None and column not in self.include):
                continue
            value = _value(raw, self.typed and column not in self.text)
            if value is not None:
                properties[column] = value
        item: dict[str, Any] = {"entity": {"type": self.entity_type, "id": _text(row.get(self.entity), f"{self.entity_type} id", MAX_ID)}, "label": label, "properties": properties}
        if self.ts:
            item["ts"] = _moment(row.get(self.ts), self.ts_format)
        return item


@dataclass
class ImportResult:
    """What an import did."""

    #: Rows read from the file.
    read: int = 0
    #: Rows the server stored now.
    stored: int = 0
    #: Rows the server already had, from an earlier run. Events only.
    duplicates: int = 0
    #: Rows that could not be imported. Each one is in the rejects file, with the reason.
    rejected: int = 0
    seconds: float = 0.0
    #: The first rows as they would be sent, for a dry run.
    sample: list[dict[str, Any]] = field(default_factory=list)
    dry_run: bool = False

    @property
    def rate(self) -> float:
        """Rows a second."""
        return self.read / self.seconds if self.seconds > 0 else 0.0


Reject = Callable[[int, str, Mapping[str, Any]], None]
Progress = Callable[[ImportResult], None]


def import_events(client: Kairos, rows: Iterable[Row], mapping: EventMapping, **options: Any) -> ImportResult:
    """Send the rows as events, in batches of 500. See ``run`` for the options."""
    mapping.check()
    return run(client, rows, mapping.event, "/v1/events", "POST", **options)


def import_entities(client: Kairos, rows: Iterable[Row], mapping: EntityMapping, **options: Any) -> ImportResult:
    """Send the rows as what is known about entities. Properties are merged into what is stored."""
    mapping.check()
    return run(client, rows, mapping.entity, "/v1/objects", "PUT", **options)


def import_labels(client: Kairos, rows: Iterable[Row], mapping: LabelMapping, **options: Any) -> ImportResult:
    mapping.check()
    return run(client, rows, mapping.item, "/v1/labels", "POST", **options)


def run(
    client: Kairos,
    rows: Iterable[Row],
    convert: Callable[[Mapping[str, Any]], dict[str, Any]],
    path: str,
    method: str,
    *,
    dry_run: bool = False,
    limit: int | None = None,
    batch_size: int = BATCH,
    on_reject: Reject | None = None,
    on_progress: Progress | None = None,
    sample_size: int = 5,
) -> ImportResult:
    """Convert each row, send them in batches, and report what happened.

    :param dry_run: Convert every row and report, and send nothing.
    :param limit: Stop after this many rows.
    :param on_reject: Called with the line number, the reason and the row, for each row that cannot be imported.
    :param on_progress: Called after each batch.

    A row the server refuses is found by sending the batch again in halves, so one bad row costs
    only itself. If the server cannot be reached after the client's retries, the import stops with
    ``KairosError``. Run it again: what was stored is not stored twice.
    """
    if not 1 <= batch_size <= BATCH:
        raise KairosError(f"batch_size must be 1 to {BATCH}")
    result = ImportResult(dry_run=dry_run)
    started = time.monotonic()
    reject = on_reject or (lambda line, reason, row: None)
    batch: list[tuple[int, dict[str, Any], Mapping[str, Any]]] = []

    def send(items: list[tuple[int, dict[str, Any], Mapping[str, Any]]]) -> None:
        if not items:
            return
        try:
            answer = client._request(method, path, {"batch": [item for _, item, _ in items]}, None, client._timeout)
        except KairosApiError as error:
            if error.status != 400:
                raise
            if len(items) == 1:
                line, _, row = items[0]
                result.rejected += 1
                reject(line, f"the server refused it: {_reason(error)}", row)
                return
            middle = len(items) // 2
            send(items[:middle])
            send(items[middle:])
            return
        accepted = int(answer.get("accepted", len(items)))
        result.stored += accepted
        result.duplicates += int(answer.get("duplicates", 0))

    for line, row in rows:
        if limit is not None and result.read >= limit:
            break
        result.read += 1
        try:
            item = convert(row)
            _encode(item)
        except (RowError, KairosError) as error:
            result.rejected += 1
            reject(line, str(error), row)
            continue
        except (TypeError, ValueError) as error:
            result.rejected += 1
            reject(line, f"a value cannot be sent as JSON: {error}", row)
            continue
        if len(result.sample) < sample_size:
            result.sample.append(item)
        if dry_run:
            continue
        batch.append((line, item, row))
        if len(batch) >= batch_size:
            send(batch)
            batch = []
            result.seconds = time.monotonic() - started
            if on_progress:
                on_progress(result)
    if not dry_run:
        send(batch)
    result.seconds = time.monotonic() - started
    if on_progress and not dry_run:
        on_progress(result)
    return result


def _reason(error: KairosApiError) -> str:
    try:
        return str(json.loads(error.body)["error"]["message"])
    except (ValueError, KeyError, TypeError):
        return error.body or f"status {error.status}"


class RejectsFile:
    """Writes each rejected row to a JSON-lines file, with its line and the reason. Opened on the first reject."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._handle: IO[str] | None = None

    def __call__(self, line: int, reason: str, row: Mapping[str, Any]) -> None:
        if self._handle is None:
            self._handle = self.path.open("w", encoding="utf-8")
        clean = {k: v for k, v in row.items() if not k.startswith("__")}
        self._handle.write(json.dumps({"line": line, "reason": reason, "row": clean}, default=str) + "\n")

    def close(self) -> None:
        if self._handle is not None:
            self._handle.close()

    def __enter__(self) -> RejectsFile:  # noqa: PYI034 - Self needs Python 3.11 or a dependency
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def progress_printer(stream: IO[str] | None = None, every: float = 2.0) -> Progress:
    """A progress line on the terminal (standard error), at most every ``every`` seconds."""
    last = [0.0]

    def show(result: ImportResult) -> None:
        out = stream or sys.stderr
        now = time.monotonic()
        if now - last[0] < every:
            return
        last[0] = now
        out.write(f"\r  {result.read:,} read · {result.stored:,} stored · {result.duplicates:,} already there · {result.rejected:,} rejected · {result.rate:,.0f} rows/s")
        out.flush()

    return show
