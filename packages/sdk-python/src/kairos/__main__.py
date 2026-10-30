"""The ``kairos`` command: ``python -m kairos import …``.

    python -m kairos import events   FILE --type TYPE --ts COLUMN [--id COLUMN] [--entity TYPE=COLUMN …]
    python -m kairos import entities FILE --type TYPE --id COLUMN
    python -m kairos import labels   FILE --entity TYPE=COLUMN --label LABEL [--ts COLUMN]
    python -m kairos train CONFIG.json [--out DIR] [--no-upload]

The key comes from ``--api-key`` or ``KAIROS_API_KEY``, and the server from ``--url`` or ``KAIROS_URL``.
It exits with 0 when the import ran to the end (rejected rows are listed in the rejects file), 1 when
it stopped (the server could not be reached), and 2 for a wrong command.
Run ``python -m kairos import events --help`` for every option.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .client import Kairos
from .errors import KairosError
from .importer import (
    EntityMapping,
    EventMapping,
    ImportResult,
    LabelMapping,
    RejectsFile,
    import_entities,
    import_events,
    import_labels,
    progress_printer,
    read_rows,
)
from .training import TrainingConfig, run


def _pair(text: str) -> tuple[str, str]:
    kind, sep, column = text.partition("=")
    if not sep or not kind or not column:
        raise argparse.ArgumentTypeError(f'"{text}" must look like TYPE=COLUMN, for example user=customer_id')
    return kind.strip(), column.strip()


def _columns(text: str) -> list[str]:
    return [c.strip() for c in text.split(",") if c.strip()]


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m kairos", description="Kairos from the command line.")
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import", help="Import history from a CSV or JSON-lines file.", description="Import history from a CSV or JSON-lines file. An import can be run again: nothing is stored twice.")
    kinds = importer.add_subparsers(dest="kind", required=True)

    def common(sub: argparse.ArgumentParser) -> None:
        sub.add_argument("file", type=Path, help="A .csv file, or a .jsonl file with one JSON object on each line.")
        sub.add_argument("--format", choices=["csv", "jsonl"], help="Default: from the file extension.")
        sub.add_argument("--delimiter", default=",", help='For a CSV file. Default ",". Use "\\t" for a tab.')
        sub.add_argument("--dry-run", action="store_true", help="Read and check every row, show the first ones as they would be sent, and send nothing.")
        sub.add_argument("--limit", type=int, help="Stop after this many rows.")
        sub.add_argument("--rejects", type=Path, help="Where to write the rows that cannot be imported. Default: FILE.rejects.jsonl")
        sub.add_argument("--include", type=_columns, help="Only these columns become properties, separated by commas.")
        sub.add_argument("--exclude", type=_columns, default=[], help="Columns that never become properties, separated by commas.")
        sub.add_argument("--text", type=_columns, default=[], help="CSV columns to keep as text even when they look like numbers.")
        sub.add_argument("--strings", action="store_true", help="Keep every CSV value as text. By default plain numbers and true/false get their type.")
        sub.add_argument("--api-key", default=os.environ.get("KAIROS_API_KEY"), help="A secret key. Default: KAIROS_API_KEY.")
        sub.add_argument("--url", default=os.environ.get("KAIROS_URL", "https://kairos.finic.ai"), help="The Kairos server. Default: KAIROS_URL, or https://kairos.finic.ai.")
        sub.add_argument("--batch-size", type=int, default=500, help="Rows in one request, 1 to 500. Default 500.")

    events = kinds.add_parser("events", help="Things that happened: transactions, logins, payouts.")
    common(events)
    kind = events.add_mutually_exclusive_group(required=True)
    kind.add_argument("--type", help="The event type of every row, for example transaction.")
    kind.add_argument("--type-column", help="The column that holds the event type.")
    events.add_argument("--ts", required=True, help="The column with the time each event happened.")
    events.add_argument("--ts-format", default="iso", help='iso (default), unix, unix_ms, or a strptime pattern such as "%%d/%%m/%%Y %%H:%%M". A time with no zone is UTC.')
    events.add_argument("--id", help="The column with a unique id for each event. Default: a hash of the row.")
    events.add_argument("--entity", type=_pair, action="append", default=[], metavar="TYPE=COLUMN", help="An entity the event names, from a column. Repeat it. Columns that end in _id are entities already.")
    events.add_argument("--no-auto-entities", action="store_true", help="Do not read columns that end in _id as entities.")
    events.add_argument("--universal-id", help="The column that groups the stages of one record.")
    events.add_argument("--status", help="The column with the state of the record at this stage.")
    events.add_argument("--session", help="The column with the session id.")

    entities = kinds.add_parser("entities", help="What is known about each entity: the customer table.")
    common(entities)
    entities.add_argument("--type", required=True, help="The entity type of every row, for example user.")
    entities.add_argument("--id", required=True, help="The column with the entity's id.")

    labels = kinds.add_parser("labels", help="Known outcomes: chargebacks, confirmed fraud.")
    common(labels)
    labels.add_argument("--entity", type=_pair, required=True, metavar="TYPE=COLUMN", help="The entity the label is on, for example user=customer_id.")
    label = labels.add_mutually_exclusive_group(required=True)
    label.add_argument("--label", help="The label of every row, for example fraud_confirmed.")
    label.add_argument("--label-column", help="The column that holds the label.")
    labels.add_argument("--ts", help="The column with the time the outcome became known. Default: now.")
    labels.add_argument("--ts-format", default="iso", help="As for events.")

    trainer = commands.add_parser("train", help="Train an XGBoost model on a workflow's runs, and upload it.", description='Train an XGBoost scoring model on the runs of a workflow, and upload it as the next version of a model. Needs pip install "finic-kairos[train]".')
    trainer.add_argument("config", type=Path, help="A JSON file: model, workflow, labels, window, features, and the options of the training.")
    trainer.add_argument("--out", type=Path, help="Also write model.json and upload.json to this folder.")
    trainer.add_argument("--no-upload", action="store_true", help="Train, and upload nothing. Use it with --out to look at the model first.")
    trainer.add_argument("--api-key", default=os.environ.get("KAIROS_API_KEY"), help="A secret key. Default: KAIROS_API_KEY.")
    trainer.add_argument("--url", default=os.environ.get("KAIROS_URL", "https://kairos.finic.ai"), help="The Kairos server. Default: KAIROS_URL, or https://kairos.finic.ai.")
    return parser


def _train(args: argparse.Namespace) -> int:
    if not args.api_key:
        sys.stderr.write("Set KAIROS_API_KEY, or pass --api-key. It must be a secret key (ksk_…).\n")
        return 2
    try:
        config = TrainingConfig.from_dict(json.loads(args.config.read_text()))
        run(config, args.url, args.api_key, out=args.out, send=not args.no_upload)
    except FileNotFoundError:
        sys.stderr.write(f"No file at {args.config}\n")
        return 2
    except json.JSONDecodeError as error:
        sys.stderr.write(f"{args.config} is not JSON: {error}\n")
        return 2
    except KairosError as error:
        sys.stderr.write(f"{error}\n")
        return 1
    return 0


def _report(result: ImportResult, rejects: Path, out: Any) -> None:
    if result.dry_run:
        out.write(f"Dry run: {result.read:,} rows read, {result.read - result.rejected:,} would be sent, {result.rejected:,} rejected. Nothing was sent.\n")
        if result.sample:
            out.write("\nThe first rows, as they would be sent:\n")
            for item in result.sample:
                out.write(f"  {item}\n")
    else:
        already = f", {result.duplicates:,} were there already" if result.duplicates else ""
        out.write(f"\n{result.read:,} rows read: {result.stored:,} stored{already}, {result.rejected:,} rejected. {result.seconds:,.1f} s, {result.rate:,.0f} rows a second.\n")
    if result.rejected:
        out.write(f"The rejected rows are in {rejects}, each with the reason.\n")


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "train":
        return _train(args)
    if not args.dry_run and not args.api_key:
        sys.stderr.write("Set KAIROS_API_KEY, or pass --api-key. It must be a secret key (ksk_…).\n")
        return 2
    common: dict[str, Any] = {"include": args.include, "exclude": args.exclude, "text": args.text, "typed": not args.strings}
    rejects = args.rejects or args.file.with_name(args.file.name + ".rejects.jsonl")
    try:
        delimiter = "\t" if args.delimiter in ("\\t", "tab") else args.delimiter
        rows = read_rows(args.file, format=args.format, delimiter=delimiter)
        client = Kairos(args.api_key or "dry-run", base_url=args.url, max_retries=5, timeout=60, flush_interval=0)
        options: dict[str, Any] = {"dry_run": args.dry_run, "limit": args.limit, "batch_size": args.batch_size, "on_progress": None if args.dry_run else progress_printer()}
        with RejectsFile(rejects) as on_reject:
            options["on_reject"] = on_reject
            if args.kind == "events":
                mapping = EventMapping(
                    type=args.type, type_column=args.type_column, ts=args.ts, ts_format=args.ts_format, id=args.id,
                    entities=dict(args.entity), auto_entities=not args.no_auto_entities,
                    universal_id=args.universal_id, status=args.status, session=args.session, **common,
                )
                result = import_events(client, rows, mapping, **options)
            elif args.kind == "entities":
                result = import_entities(client, rows, EntityMapping(type=args.type, id=args.id, **common), **options)
            else:
                kind, column = args.entity
                mapping_l = LabelMapping(entity_type=kind, entity=column, label=args.label, label_column=args.label_column, ts=args.ts, ts_format=args.ts_format, **common)
                result = import_labels(client, rows, mapping_l, **options)
    except FileNotFoundError:
        sys.stderr.write(f"No file at {args.file}\n")
        return 2
    except KairosError as error:
        sys.stderr.write(f"\n{error}\nNothing that was stored is lost. Correct the problem and run the same command again: rows already stored are not stored twice.\n")
        return 1
    _report(result, rejects, sys.stdout)
    # The import ran to the end. Rejected rows are reported, not an error: run again after correcting them.
    return 0


if __name__ == "__main__":
    sys.exit(main())
