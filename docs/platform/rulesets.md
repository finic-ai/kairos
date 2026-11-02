# Rulesets

A ruleset is a list of rules that reads only the input you give it and answers **approve** or **reject**. A workflow runs one with the [Run a ruleset](workflows.md#run-a-ruleset) step, and fills and reads lists with the [list steps](workflows.md#add-to-a-list-remove-from-a-list) and `inList`. It makes no call: no HTTP request, no record, no model. So the same input and the same version always give the same answer.

```
input ──▶ rule 1 ──▶ rule 2 ──▶ rule 3 ──▶ no rule matches
           │           │           │             │
         matches?    matches?    matches?     the default
           ▼           ▼           ▼
        its outcome and its response
```

- [Build one in the console](#build-one-in-the-console)
- [How a ruleset answers](#how-a-ruleset-answers)
- [Conditions](#conditions)
- [Lists](#lists)
- [Tests](#tests)
- [Drafts and versions](#drafts-and-versions)
- [The API](#the-api)
- [Limits](#limits)

## Build one in the console

Open **Settings › Rulesets** and choose **New ruleset**. Start from scratch, or from a template. Each template has its inputs, its rules and tests, and publishes as it is. Change the limits to your own before you publish.

| Group | Templates |
|---|---|
| Payments | High-risk payout, large transfer to a new payee, amounts just under a limit, large round amounts, older customer with a new device and payee, money in and money out, velocity limits, card testing |
| Accounts | Sign-up screening, dormant account wakes up, account takeover signs, impossible travel |
| Identity | Identity does not match, high-risk jurisdiction |
| Commerce | Billing and shipping do not match, promotion abuse, refund and chargeback abuse |
| Lending | Loan stacking |

The templates use the same name for the same input, such as `amount`, `account_age_days`, `new_device` and `new_payee`, so the inputs that your workflows give fit more than one template.

The builder shows the ruleset as cards, from the top:

1. **Start**: the inputs. Click it to add an input, its type and whether it is required.
2. **One card for each rule**, in order. Each card shows **If**, the rule's conditions, and **Then**, its outcome. Click a card to change it. **⋯** moves, copies or deletes it.
3. **+ Add rule** adds a rule at the end.
4. **No rule matches**: the outcome when no rule matches.

**Catalog** opens the standard inputs at the left, in groups such as Transaction, Account, Device and location, and Identity: the inputs that the templates use, by the same names. Click one to add it to the ruleset. A condition can also choose a catalog input, and the ruleset then has it as an input. The catalog only names an input: what calls the ruleset gives its value.

**Test** opens a panel: give an input and choose **Run**. The rule that matched is marked on the canvas, and the panel shows the outcome and the response. **Keep as a test** adds the input to the ruleset's tests.

**Save** keeps a draft. **Publish** runs the tests and makes the draft the next version.

## How a ruleset answers

The rules run in order. The **first** rule whose condition is true gives the outcome and its response. When no rule matches, the default does.

```json
{
  "ruleset": "high_risk_payout@2",
  "outcome": "reject",
  "matched": true,
  "rule": "new_account_large",
  "response": { "reason": "new_account_large_amount" },
  "terms": [],
  "missing": []
}
```

| Field | |
|---|---|
| `ruleset` | The slug and the version that answered |
| `outcome` | `approve` or `reject` |
| `matched` | `true` when a rule matched, `false` when the default answered |
| `rule` | The id of the rule that matched, or `null` |
| `response` | The JSON of that rule, or of the default. `null` when it has none |
| `terms` | The list items that the rule matched, as `{ list, item }` |
| `missing` | The rules that did not run, because they read an input that is not there |

Put the rules that **approve** first when they must win: a trusted customer, for example, before the rules that reject.

### Inputs

Each input has a name, a type (`text`, `number`, `boolean`, `list` or `object`) and can be required. A rule reads it as `input.<name>`.

- An input that is **required** and not there, or of the wrong type, refuses the request with 400, and the message names it: `input.amount: is required`.
- An input that is **not required** and not there, or `null`, is missing. A rule that needs it does not match, and its id is in `missing`. The next rule runs.
- An input that the ruleset does not declare is kept, and the rules can read it too.

## Conditions

A condition is a form: a field, an operator and a value, joined by **all** or **any**. **Write an expression** shows it as a [CEL](https://cel.dev) expression, for what the form does not cover.

```
input.amount >= 1000 && input.country in ['KP', 'IR']
input.email_domain.endsWith('.ru')
input.account_age_days < 7 || input.new_payee == true
inList(input.email_domain, 'disposable_domains')
```

A condition must give `true` or `false`.

## Lists

A list is a set of terms that rules read: email domains, BINs, payee ids, words in a payment reference. A rule reads one with `inList(value, 'slug')`, or with **is in the list** in the form. Each item is text; a number in the input is compared as text.

Each item has a **match** and a **case**. The list has a default of each, and an item can have its own:

| `match` | `inList` is true when | Use it for |
|---|---|---|
| `exact` | The value is the item. The default. | Payee ids, device ids, email addresses, domains |
| `prefix` | The value starts with the item | BINs: `411111` matches `4111111111111111`. Phone codes: `+234` |
| `suffix` | The value ends with the item | Domains with their subdomains: `mailinator.com` matches `x.mailinator.com` |
| `contains` | The item is anywhere in the value, also inside a longer word | `crypto` in `cryptocurrency` |
| `word` | The item is in the value as a whole word | `gift card` in `buy a gift card`, but `card` not in `cardholder` |

`case_sensitive` is `false` by default: `Mailinator.com` matches `mailinator.com`. With `true`, `BTC` does not match `btc`.

Most lists hold one kind of thing, so set the match and the case on the list, and leave the items without their own. Give an item its own when one list mixes kinds, such as a list of terms where most must be whole words and one can be part of a word.

**A list is live.** A change to its items, or to its default match or case, takes effect at once, in each ruleset that reads it, and makes no new version. The result keeps the item that matched in `terms`, so you can see why a rule matched after the item is removed. A list that a ruleset reads cannot be deleted.

### Make a list in the console

Open **Settings › Lists** and choose **New list**. Give it a name; Kairos makes the slug from it. Choose the default match and case.

On the list's page, **Add items** opens a window with two ways to add:

- **Bulk Add**: one item for each line, or split at **new lines and commas**. A cell in quotes can hold a comma. **Open a file** reads a text or CSV file into the box. Choose a match, a case and a note for all of these items, or keep the list's.
- **Manual**: a row for each item, with its own match, case and note. Enter adds a row.

An item that is on the list already takes the new match, case and note. Items with the same text are the same item, in any case unless the item is case sensitive.

The table shows each item with the match it uses, and **Its own** when it does not use the list's. **✎** changes an item's match, case and note. To remove items, select them with their boxes, also on more than one page, and choose **Delete**. **Edit** changes the list's name, description, and default match and case, and says how many items the change affects. **Read by** names the rulesets that read the list.

On **Settings › Lists**, the **Actions** of each list edit it or delete it. A list that a ruleset reads cannot be deleted: change the ruleset first.

### Make a list with the API

```bash
curl -s -X PUT https://kairos.finic.ai/v1/lists/disposable_domains \
  -H "Authorization: Bearer $KAIROS_API_KEY" -H "Content-Type: application/json" \
  -d '{ "name": "Disposable email domains", "match": "suffix" }'

curl -s -X POST https://kairos.finic.ai/v1/lists/disposable_domains/items \
  -H "Authorization: Bearer $KAIROS_API_KEY" -H "Content-Type: application/json" \
  -d '{ "items": [{ "value": "mailinator.com", "note": "Disposable" }, { "value": "yopmail.com", "match": "exact" }] }'
```

An item's `match` and `case_sensitive` are optional. `null` sets an item back to the list's.

## Tests

A test is an input and the outcome it must give, and optionally the rule that must give it, or **no rule** for the default. **Publish** runs every test, and refuses to publish when one fails, with the test and what it gave:

```
tests.0: "New account, large amount" gave approve from the default, not reject from the rule "new_account_large"
```

## Drafts and versions

| | |
|---|---|
| **Draft**, never published | It cannot be evaluated. A new ruleset starts here, at version 0. |
| **Published** | The live version. Each publish makes the next version: 1, 2, 3. |
| **Published, with a draft** | The live version answers. The draft is your changes until you publish. |
| **Archived** | Its versions stay, and it still answers. **Restore** brings it back. |

A ruleset has a **slug**, such as `high_risk_payout`, which never changes, and a **name**, a **description** and **settings**, which you can change at any time. A change to the name, the description or the settings makes no new version: they do not change an answer. Settings are any JSON object that you want to keep with the ruleset; no rule reads them.

A publish checks each condition, each list that a rule reads, and each test.

## The API

Each request needs a secret key, or the console's session, and works in the key's environment. `:ruleset` and `:list` are the slug or the id (`rls_…`, `lst_…`).

| Request | |
|---|---|
| `GET /v1/rulesets` | `{ rulesets, total }`. `?archived=true` lists the archived ones, `?q=` searches the name and the slug. `?limit=` (default 100, at most 500) and `?offset=` give one page. |
| `PUT /v1/rulesets/:ruleset/draft` | `{ name?, description?, definition }`. Saves the draft. A new slug makes a ruleset, and needs `name`. |
| `POST /v1/rulesets/:ruleset/publish` | Checks the draft, runs its tests, and makes it the next version. |
| `DELETE /v1/rulesets/:ruleset/draft` | Drops the draft. |
| `PATCH /v1/rulesets/:ruleset` | `{ name?, description?, settings? }`. No new version. |
| `GET /v1/rulesets/:ruleset` | The live version, with `draft` when there is one. `?version=2` reads a version. |
| `GET /v1/rulesets/:ruleset/versions` | Every version. |
| `POST /v1/rulesets/:ruleset/evaluate` | `{ input }`. The result of the live version, or of `?version=`. |
| `POST /v1/rulesets/test` | `{ definition, input? }`. Evaluates a definition that is not saved, and runs its tests. Writes nothing. |
| `POST /v1/rulesets/:ruleset/archive`, `/restore` | Archive or restore. |
| `GET /v1/ruleset-templates` | The templates. |
| `GET /v1/lists` | `{ lists, total }`: the lists, with their item counts. `?q=`, `?limit=` and `?offset=` as for rulesets. |
| `PUT /v1/lists/:list` | `{ name?, description?, match?, case_sensitive? }`. Makes a list, with a new slug and a name, or changes one. |
| `GET /v1/lists/:list` | The list with its items. |
| `GET /v1/lists/:list/readers` | `{ rulesets: [{ slug, name }] }`: the rulesets that read the list. |
| `POST /v1/lists/:list/items` | `{ items: [{ value, match?, case_sensitive?, note? }] }`. Adds items: `{ added, updated, list }`. An item that is there already takes the new match, case and note. |
| `DELETE /v1/lists/:list/items` | `{ values }`. Removes items. |
| `PUT /v1/lists/:list/items` | `{ items }`. Replaces every item, for a sync from another system. |
| `DELETE /v1/lists/:list` | Refused with 409 while a ruleset reads it. |

The definition of a ruleset:

```json
{
  "inputs": [
    { "name": "amount", "type": "number", "required": true },
    { "name": "account_age_days", "type": "number" }
  ],
  "rules": [
    {
      "id": "new_account_large",
      "name": "Large payout from a new account",
      "when": "input.account_age_days < 7 && input.amount >= 1000",
      "outcome": "reject",
      "response": { "reason": "new_account_large_amount" }
    }
  ],
  "default": { "outcome": "approve" },
  "tests": [
    { "name": "New account", "input": { "amount": 1500, "account_age_days": 2 }, "outcome": "reject", "rule": "new_account_large" }
  ]
}
```

A slug is lower-case letters, digits and `_`, and starts with a letter. A ruleset's slug cannot start with `rls_` or be `test`; a list's cannot start with `lst_`.

## Limits

| | |
|---|---|
| Rules in a ruleset | 50 |
| One condition | 2,000 characters |
| Inputs | 30 |
| Tests | 50 |
| Lists that one ruleset reads | 10 |
| A response | 16 KB of JSON |
| Items in a list | 10,000, and 1 MB |
| One item | 256 characters |
| Items in one call that adds or removes | 1,000 |
