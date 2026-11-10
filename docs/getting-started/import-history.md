# Import your history

A new workspace knows nothing about your customers, so its first decisions have little to read. Import what you already have, before you ask for the first decision:

- **Events**: transactions, logins, payouts, account changes. This is the history a decision reads.
- **Entities**: what you know about each customer, merchant or account.
- **Labels**: the outcomes you already know, such as chargebacks and confirmed fraud. These make links useful from the first day: a decision about a new account can see that its device was used by a customer with a chargeback.

There are two ways:

- **In the console**, for entities: an **Import** button on each entity type's page. No code. See [From the console](#from-the-console).
- **On the command line**, for events, entities and labels, and for large files. The rest of this page is about this way.

For a Shopify store, the Shopify source can [import past orders and disputes](../platform/webhooks/inbound.md#import-past-shopify-orders) itself, with no file.

There are two command-line importers with the same options and the same rules: `kairos import`, in the [Kairos CLI](../../README.md#the-cli), and `python -m kairos import`, in the [Python SDK](../reference/clients/python.md). They read CSV and JSON-lines files and send them through the normal API, so an imported event is the same as one you track. An import of history makes no decisions. A file gives the same events with both, with the same ids, so you can change from one to the other and nothing is stored twice.

## From the console

On **Entities**, open a type (for example **Users**) and choose **Import**.

1. **Choose a file**, or drop it on the dialog: CSV or JSON lines, up to 50 MB.
2. **Say which column is the id.** The console suggests one: `user_id` for users, then `id`, then a column that ends in `_id`. It also finds the delimiter of a CSV file (comma, semicolon, tab or pipe), and you can change it.
3. **Choose the properties.** Clear a column to leave it out, for example a password or a column you do not want in Kairos. Mark a column as **text** to keep values such as phone numbers exactly as written.
4. **Check the preview**: the first rows as they will be stored, the number of rows to import, and the rows that cannot be used, with the reason. Values that get a type of their own (a number, true or false) are shown in color. Nothing is sent yet.
5. **Import.** The rows go in batches of 500. When it finishes, **Download rejected rows** gives a CSV of the rows that were not stored, each with its line and the reason.

The console reads the file with the same rules as the command line, so the same file is stored the same way. Two rows with the same id are one entity: their properties are merged, and the later row wins. Run the import again to update: properties are merged into what is stored.

For events and labels, and for a file larger than 50 MB, use the command line.

## Before you start

With the [Kairos CLI](../reference/clients/cli.md) (`npm install -g @kairos/cli`), sign in: `kairos login --url https://kairos.finic.ai --key ksk_…`, with a secret key of the workspace. The import goes to the workspace and the environment that `kairos whoami` shows.

With Python:

- Python 3.9 or later, and the SDK: `pip install finic-kairos`
- A **secret** key (`ksk_…`) for the workspace, from **Settings › API keys**

```bash
export KAIROS_API_KEY=ksk_…
```

## The three commands

```bash
kairos import events   transactions.csv --type transaction --ts created_at --id txn_id --entity user=customer
kairos import entities customers.csv    --type user --id customer_id
kairos import labels   chargebacks.csv  --entity user=customer_id --label chargeback --ts reported_at
```

With Python, the commands are the same after `python -m kairos import`. The order does not matter. Run each one with `--dry-run` first.

Two small differences: the Kairos CLI does not need `--id` for `import entities` (without it, it uses the column that the console suggests, and says which one), and it sends to the server of your sign-in. Use `--profile` or `--url` to send to another server.

## How a row becomes an event

| Part of the event                   | Where it comes from                                                                                                                                                     |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                              | `--type transaction` for the whole file, or `--type-column` for a column that holds it.                                                                                 |
| `ts`                                | `--ts`: the column with the time the event happened. Necessary: history has its own times.                                                                              |
| `id`                                | `--id`: a column with a unique id. Without it, the id is a hash of the row.                                                                                             |
| `entities`                          | Each column that ends in `_id`: `device_id` is the entity `device`. And each `--entity TYPE=COLUMN`, for columns with other names. A row must name at least one entity. |
| `properties`                        | Every other column.                                                                                                                                                     |
| `universal_id`, `status`, `session` | `--universal-id`, `--status` and `--session`: columns for [records with stages](../concepts/core-concepts.md#record) and [sessions](../concepts/core-concepts.md#session).        |

An example. This file:

```csv
txn_id,created_at,customer,device_id,amount,currency,status
t1,2026-03-12 13:23:00,cust_0,dev_0,647.74,GBP,completed
```

with `--type transaction --ts created_at --id txn_id --entity user=customer --status status` becomes:

```json
{
  "id": "t1",
  "type": "transaction",
  "ts": "2026-03-12T13:23:00.000Z",
  "entities": { "user": "cust_0", "device": "dev_0" },
  "properties": { "amount": 647.74, "currency": "GBP" },
  "status": "completed"
}
```

**Use the same ids as your live integration.** If your server tracks `userId: "cust_0"`, the import must name `user` as `cust_0` too. Otherwise the history is on a different entity from the one your decisions are about.

### Values in a CSV file

A CSV file has only text, so the importer gives a value its type:

- A plain number becomes a number: `647.74`, `3`, `-12`.
- `true` and `false` become booleans.
- An empty cell is no value.
- **A number with a leading zero stays text** (`02139`), and so does a number of 16 digits or more (a card or an account number). These are codes, and a number would change them.
- `--text COLUMN,…` keeps other columns as text. `--strings` keeps every value as text.

A JSON-lines file keeps its own types.

### Times

`--ts-format` says how the time column is written:

| Format               | Example                                                     |
| -------------------- | ----------------------------------------------------------- |
| `iso` (default)      | `2026-03-12T13:23:00Z`, `2026-03-12 13:23:00`, `2026-03-12` |
| `unix`               | `1773321780`                                                |
| `unix_ms`            | `1773321780000`                                             |
| A `strptime` pattern | `--ts-format "%d/%m/%Y %H:%M"` for `12/03/2026 13:23`       |

**A time with no time zone is read as UTC.** If your file has local times, convert them first, or add the offset to the column.

## Entities and labels

`import entities` stores each row as what is known about one entity. `--id` names the id column, and every other column is a property. Properties are merged into what is stored, so a second file adds to the first.

`import labels` puts a label on one entity for each row. `--entity user=customer_id` says which entity. `--label chargeback` gives the label of every row, or `--label-column` names a column that holds it. `--ts` is the time the outcome became known; without it, the time of the import. The other columns become properties of the label.

A decision made as of a past moment does not see a label from after that moment, so give labels their real dates if you want to [backtest](../reference/clients/python.md#backtesting).

## Safe to run again

- **`--dry-run`** reads and checks every row, shows the first five as they would be sent, and sends nothing. It needs no key.
- **Nothing is stored twice.** Each event has an id, and the server stores an id once. A second run of the same file reports the rows as "already there". If an import stops in the middle, run the same command again.
- **A row with no `--id` column gets an id from a hash of its content**, so the same row gets the same id each time. Two rows that are exactly the same are stored once.
- **Bad rows do not stop the import.** A row with no entity, a time that cannot be read, or a value the server refuses goes to a rejects file next to your file (`transactions.csv.rejects.jsonl`), with its line number and the reason. Correct those rows and run the import again on the whole file.

```
50,002 rows read: 50,000 stored, 2 rejected. 8.7 s, 5,759 rows a second.
The rejected rows are in transactions.csv.rejects.jsonl, each with the reason.
```

```json
{"line": 50002, "reason": "\"last tuesday\" is not a time", "row": {"txn_id": "t_bad_time", "created_at": "last tuesday", …}}
```

The command exits with 0 when it ran to the end, also with rejected rows; with 1 when it stopped because the server could not be reached; and with 2 for a wrong command.

## How long it takes

Measured with the server on the same machine as the file, so with no network time:

| Import                                   | Rows a second |
| ---------------------------------------- | ------------- |
| Events, the first time                   | about 5,800   |
| Events, a second run (all already there) | about 15,000  |
| Entities                                 | about 3,000   |

So a year of history for 2,000 customers, 50,000 transactions, takes about 9 seconds there. Over the internet it is slower, because each batch of 500 waits for the network. Measure your own with `--limit 10000`.

## Things to know

- **Usage counts imported events on the day you import them.** **Settings › Usage** shows a large import as a spike that day.
- **An import of history does not start decisions**, also for an event type that is the trigger of an action: an action with [`automatic`](../concepts/core-concepts.md#action) decides only events of the last hour. A row dated in the last hour can start one.
- **Event properties are not entity properties.** A `plan` column in a transactions file is stored on each event, not on the customer. Put what describes the customer in the entities file.
- **The rejects file contains your data.** Delete it when you are done.

## Every option

```bash
kairos import --help
python -m kairos import events --help
```

| Option                                                                                                                                | Commands |                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `--format csv\|jsonl`                                                                                                                 | all      | Default: from the file extension.                                                                                   |
| `--delimiter`                                                                                                                         | all      | For a CSV file. `\t` for a tab.                                                                                     |
| `--dry-run`                                                                                                                           | all      | Check and show, send nothing.                                                                                       |
| `--limit N`                                                                                                                           | all      | Stop after N rows.                                                                                                  |
| `--rejects PATH`                                                                                                                      | all      | Where the rejected rows go.                                                                                         |
| `--include`, `--exclude`                                                                                                              | all      | Columns to use, or to leave out, as properties. Separated by commas.                                                |
| `--text`, `--strings`                                                                                                                 | all      | Keep columns, or every column, as text.                                                                             |
| `--api-key`, `--url`                                                                                                                  | all      | Python only. Default: `KAIROS_API_KEY`, and `https://kairos.finic.ai` (or `KAIROS_URL`). The Kairos CLI uses your sign-in, `--profile` and `--url`. |
| `--batch-size`                                                                                                                        | all      | Rows in one request, 1 to 500.                                                                                      |
| `--type`, `--type-column`, `--ts`, `--ts-format`, `--id`, `--entity`, `--no-auto-entities`, `--universal-id`, `--status`, `--session` | events   | See above.                                                                                                          |
| `--type`, `--id`                                                                                                                      | entities | The entity type, and the id column.                                                                                 |
| `--entity`, `--label`, `--label-column`, `--ts`, `--ts-format`                                                                        | labels   | See above.                                                                                                          |

## From Python

The same importer is a library, for a pipeline or a notebook:

```python
from kairos import Kairos
from kairos.importer import EventMapping, RejectsFile, import_events, read_rows

with Kairos(api_key, base_url=url) as kairos, RejectsFile("rejects.jsonl") as rejects:
    result = import_events(
        kairos,
        read_rows("transactions.csv"),
        EventMapping(type="transaction", ts="created_at", id="txn_id", entities={"user": "customer"}),
        on_reject=rejects,
    )
print(result.stored, result.duplicates, result.rejected)
```

`read_rows` gives `(line, row)` pairs, so any iterable of `(line, dictionary)` pairs works too: rows from a database cursor, for example. `import_entities` with `EntityMapping` and `import_labels` with `LabelMapping` do the same for the other two kinds.
