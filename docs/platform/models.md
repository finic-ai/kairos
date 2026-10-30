# Models

A workflow step that uses a model names it. Kairos has two kinds of model, and each step type uses one kind.

| Kind | Reads | Gives | Models | Steps |
|---|---|---|---|---|
| **Question model** | A case: its history, links and labels, and data | A probability for each answer to questions in plain language | `grayson-1`, built in | [Get the model's decision](workflows.md#get-the-models-decision), [Ask a question](workflows.md#ask-a-question) |
| **Scoring model** | Numbers, called features | One probability, from 0 to 1 | XGBoost models that you train and upload | [Score with a model](workflows.md#score-with-a-model) |

A question model needs no labels of yours. A scoring model learns from your own outcomes, and it can take a question model's answers as its features. This is the method of Finic's tests on [insurance fraud](https://finic.ai/blog/decision-models-xgboost-insurance-fraud) and [loan default](https://finic.ai/blog/decision-models-xgboost-loan-default): an XGBoost model with Grayson's answers ranked cases better than the same model without them.

## The models of an environment

**Settings › Models** in the console lists them, and `GET /v1/models` returns them.

- `grayson-1` is built in. It is in every environment, and it cannot be changed.
- An uploaded model has a **slug**, such as `loan-default`, which steps use and which never changes, and a **name**, such as "Loan default", which people see and which you can change.
- Each upload is a **version**: `loan-default@1`, `loan-default@2`. A version never changes.
- A model belongs to one environment, as an action does. A new sandbox gets the models that you select under **Models** in its copy (**Settings › Environments**), with all their versions and the same version numbers, so that `loan-default@2` is the same file there. Archived models are not copied.

A model's page shows its features, its metrics and the training details, its versions, the workflows that use it, and a form that scores one row.

## Add a scoring model

The steps, from a workflow with no model to a decision that a model scores.

### 1. A workflow that asks Grayson

Build a [decision workflow](workflows.md#decision-request) that asks the questions whose answers you want as features. Each `ask` step has 1 to 75 questions, and all of them are one call to the model. A `yes_no` answer's `probability` is a good feature.

```json
{ "id": "ask", "name": "Read the application", "type": "ask",
  "data": { "purpose": "{{ trigger.properties.purpose }}" },
  "questions": {
    "hardship": { "type": "yes_no", "question": "Does the borrower describe current financial hardship?" },
    "income_plausible": { "type": "yes_no", "question": "Is the stated income plausible for the job title?" } } }
```

Publish it without a score step for now, with an Answer step that gives an outcome.

### 2. Runs to learn from

The training rows are the workflow's own runs: each run that is done, cancelled, or waiting. A run that failed, or that is still running, is not a row. There are two ways to get runs:

- **Live:** let the workflow decide for some weeks, then train.
- **From history:** in a sandbox, make decisions as of past moments over your history. Each one runs the workflow as far as its answer.

For history, copy the events, entities and actions from production into a new sandbox (**Settings › Environments**), build the workflow there, and call `decide` with a `ts` for each past request:

```python
for row in past_requests:
    kairos.decide("loan", {"user_id": row["user"], "amount": row["amount"], "purpose": row["purpose"]}, timestamp=row["created_at"])
```

Use a sandbox: these decisions go into the decision log. Each one costs a model call for each `ask` and `assess` step.

### 3. Labels

A row is positive when its subject got one of your labels, such as `charged_off`, after the run and within a window, such as 180 days. Import the outcomes with their real times: see [Import your history](../getting-started/import-history.md).

### 4. Train

Install the training extra, and write a config file:

```bash
pip install "finic-kairos[train]"
```

```json
{
  "model": "loan-default",
  "name": "Loan default",
  "workflow": "loan_review",
  "labels": ["charged_off"],
  "window": "180d",
  "features": {
    "hardship": "{{ steps.ask.output.hardship.probability }}",
    "income_plausible": "{{ steps.ask.output.income_plausible.probability }}",
    "amount": "{{ trigger.properties.amount }}",
    "country_gb": "{{ trigger.properties.country == 'GB' ? 1 : 0 }}"
  },
  "compare_without": ["hardship", "income_plausible"]
}
```

```bash
python -m kairos train model.json --out ./loan-default
```

| Key | |
|---|---|
| `model`, `name` | The slug and, for the first version, the name. |
| `workflow` | The workflow whose runs are the rows. |
| `labels`, `window` | What makes a row positive, and for how long after the run. |
| `features` | Feature name → a number, or a template that reads it from a run. The same map goes into the score step. The names are letters, digits and `_`. |
| `subject` | For a workflow that makes no decisions: `{ "type": "user", "id": "{{ trigger.user }}" }`. |
| `from`, `to` | Only the runs in this period. |
| `split` | Default `{ "train": 0.7, "valid": 0.15 }`. The rest, the newest rows, is the test. |
| `params`, `rounds`, `early_stopping_rounds` | XGBoost's. The objective is always `binary:logistic`. |
| `compare_without` | Also train without these features, and report the gain. |
| `samples` | How many rows Kairos checks at upload, 100 to 1,000. Default 1,000. |

The command does this:

1. It downloads the rows: the features of each run, read as a score step reads them, and the label.
2. It splits them by time: the oldest train, and the newest test. A random split looks better than the model will be.
3. It trains with early stopping, and cuts the model to its best iteration.
4. It prints the test ROC-AUC and PR-AUC. With `compare_without`, it prints the gain over a model without those features, with a 95% interval. When the interval is above zero, those features help.
5. It uploads the model, with sample rows and their scores, the metrics and the training details.

```
5,000 rows, 1,978 positive. Left out: 2 already labeled, 1 with no outcome yet, 0 with no subject.
Test: 750 rows, ROC-AUC 0.6691, PR-AUC 0.5384, 8 trees.
Without hardship: ROC-AUC 0.4848. Gain +0.1844, 95% [+0.1307, +0.2358].
Uploaded loan-default@1: a new version.
```

`--out DIR` also writes `model.json` and `upload.json`. With `--no-upload`, nothing goes to Kairos.

### 5. What Kairos checks at upload

Kairos scores XGBoost models in its own server, with no Python. Thus it refuses a model that it cannot score exactly as XGBoost does:

- The booster is `gbtree`, the objective is `binary:logistic`, there is one output, and every feature is numeric and named.
- The file is a valid tree model, cut to its best iteration.
- Kairos scores each sample row, and each score is within 1e-6 of the score that XGBoost gave it. The answer names the first rows that differ.

An upload that is the same as the latest version makes no new version, so the command is safe to run again.

### 6. Score in the workflow

Add a **Score with a model** step after the `ask` step, and give the probability to the answer:

```json
{ "id": "xgb", "name": "Score default risk", "type": "score", "model": "loan-default@1",
  "features": { "hardship": "{{ steps.ask.output.hardship.probability }}", … } }
{ "id": "high", "name": "High risk", "type": "condition", "when": "steps.xgb.output.score >= 0.5",
  "then": [{ "id": "hold", "name": "Hold", "type": "answer", "value": { "outcome": "review", "probability": "{{ steps.xgb.output.score }}" } }],
  "else": [{ "id": "ok", "name": "Approve", "type": "answer", "value": { "outcome": "approve", "probability": "{{ steps.xgb.output.score }}" } }] }
```

In the console, choosing the model fills each feature with the value it was trained with. A test run scores for real: a score costs nothing and changes nothing. The decision keeps each score and the values that made it, and its page shows them.

Choose the thresholds again. A model's scores are not spread like Grayson's probabilities, so a threshold of 0.5 means something else.

### 7. Into production

A model trained in a sandbox is in the sandbox only. **Promote** the version: on its page in the sandbox, choose **Promote** and the environment, or use the CLI:

```bash
kairos models promote loan-default@3 --to production
```

The same file becomes the next version of the model in production. Production checks its samples again, and the new version records the sandbox, the version and the file's hash, which its page shows under **Promoted from**. Its version number can be different from the sandbox's, and the answer gives it. Then build the score step in the production workflow, with that version.

A promotion needs a person who is signed in, in the console or with `kairos login --email`. An API key is for one environment, so it cannot promote. With a production key, send the same upload instead:

```bash
kairos models upload loan-default --upload loan-default/upload.json
```

## Experiments

An experiment tries several ways of scoring a decision workflow on its labeled runs, and tells you which decides best. You, or an agent through [MCP](../reference/mcp.md), choose the variants; the server trains, validates and tests them, and nothing runs on your side.

```json
POST /v1/workflows/loan_review/experiments
{
  "name": "Do the borrower's words add to the numbers?",
  "labels": ["charged_off"],
  "window": "180d",
  "features": {
    "amount": "{{ trigger.properties.amount }}",
    "dti": "{{ trigger.properties.dti }}",
    "credit_score": "{{ trigger.properties.credit_score }}",
    "hardship": "{{ steps.ask.output.hardship.probability }}",
    "repayment_plan": "{{ steps.ask.output.repayment_plan.probability }}"
  },
  "baseline": "numbers",
  "variants": [
    { "key": "numbers", "name": "Trees on the numbers", "drop_steps": ["ask"],
      "model": { "type": "gbdt", "features": ["amount", "dti", "credit_score"] } },
    { "key": "numbers-and-words", "name": "Trees on the numbers and the answers",
      "model": { "type": "gbdt", "features": ["amount", "dti", "credit_score", "hardship", "repayment_plan"] } },
    { "key": "stacked", "name": "Answers stacked on the trees",
      "model": { "type": "stacked",
                 "base": { "type": "gbdt", "features": ["amount", "dti", "credit_score"] },
                 "features": ["hardship", "repayment_plan"],
                 "transforms": { "hardship": "logit", "repayment_plan": "logit" } } }
  ]
}
```

| Key | |
|---|---|
| `features` | Name → a template read over each run, as a [score step](workflows.md#score-with-a-model) reads it. Every variant reads from these. |
| `variants` | 1 to 12. `key` is lowercase letters and digits joined by `-`. `drop_steps` names steps the variant does not need, such as an ask step whose answers it does not read. |
| `labels`, `window`, `subject`, `from`, `to` | Which runs are rows, and which are positive, as for [training data](../reference/api.md#workflows). |
| `split` | Default `{ "train": 0.6, "valid": 0.2 }`, by time: the oldest train, the next validate, the newest test. |
| `metric` | `roc_auc` (default) or `pr_auc`: on validation, it names the best variant. |
| `baseline` | The variant the others are compared with. Default: the first. |
| `review_rate`, `block_rate` | The share of validation runs above each threshold. Defaults 0.1 and 0.02. |
| `model_prefix` | The models' slugs start with it. Default: the workflow's name. Each slug ends with part of the experiment's id, so an experiment never adds a version to a model that workflows already use. |

A variant's `model` is one of:

| `type` | Fields | What scores a run |
|---|---|---|
| `gbdt` | `features`, `params` | Gradient-boosted trees, trained by Kairos and saved as an XGBoost model. `params`: `max_depth` (4), `eta` (0.1), `rounds` (300), `min_child_weight`, `lambda`, `gamma`, `subsample`, `colsample`, `bins`, `early_stopping_rounds` (30). |
| `logistic` | `features`, `transforms`, `l2` | A [logistic model](#logistic-models). Give a probability the `logit` transform. |
| `stacked` | `base` (a `gbdt`), `features`, `transforms`, `l2` | The base model's score, as `base`, and `features` in a logistic layer. |
| `probability` | `feature` | One value as it is, such as a question model's probability. Nothing is trained. |

How the server runs it:

1. It reads the rows as [`training-data`](../reference/api.md#workflows) does, with every feature: the newest 100,000 labeled runs.
2. A tree model fits the training rows, and stops early on the newest part of them, not on the validation rows. A logistic model fits the training rows. A stacked model's trees fit the older 70% of the training rows and its layer the newer 30%, on scores the trees did not train on. So the validation metric of every variant is a fair one.
3. Each variant scores the validation and test rows with the same scorer as a score step. Its review and block thresholds come from its validation scores.
4. It reports, for each variant, the validation and test ROC-AUC and PR-AUC, the gain over the baseline on the test rows with a 95% bootstrap interval, and precision and recall at its thresholds. `best` is the variant with the best validation metric.
5. It uploads each variant's models as `<prefix>-<key>-<id>` (and `<prefix>-<key>-base-<id>`), and writes the workflow's steps with the variant deciding: the workflow's steps without their answers and the dropped steps, then score steps, then block, review or approve by the score. `removed_steps` lists the steps it leaves out. A variant gets a problem, and cannot be applied, when a feature it reads comes from a removed step, or when a `probability` feature has no value in some runs.

An experiment is `queued`, then `running`, then `done` or `failed` with its `error`. It needs at least 100 labeled runs, with both outcomes in each part. After an error that can pass, such as a lost database connection, it is `queued` again with its `error` until the retry. A variant that cannot be trained is left out of the results and listed in `dataset.failed`; the others still run.

**Choose and apply.** `POST /v1/workflow-experiments/:id/apply` with `{ "variant", "reason", "publish" }` writes the variant's steps as the workflow's draft, or with `publish` as its next version, and records who chose it and why. The best on validation is a suggestion: weigh the test metrics and the gain's interval. An experiment is applied once. Apply answers 409 when a variant was applied already, when the workflow has a newer version than the one the experiment ran on, or, without `publish`, when the workflow has a draft.

In the console, a workflow's **Experiments** tab, beside **Builder** and **Runs**, lists its experiments; the count on the tab shows in colour while one runs. The **⋯** menu has **Experiments** too. Each experiment shows its variants, their accuracy, the best, the one chosen and why, and **Apply**.

## Logistic models

A logistic model weighs a few scores together, such as a tree model's score and a question model's answers, each as log-odds. Experiments make them; you can also upload one with `"format": "logistic-json"`:

```json
{
  "format": "logistic-json",
  "model": {
    "features": ["xgb", "hardship"],
    "transforms": { "xgb": "logit", "hardship": "logit" },
    "coefficients": [1.02, 0.31],
    "intercept": -0.4,
    "fill": { "hardship": 0.5 }
  },
  "samples": [{ "features": { "xgb": 0.12, "hardship": null }, "score": 0.08 }, …]
}
```

- **The score** is `1 / (1 + e^-z)`, with `z = intercept + Σ coefficient × value`. A value with the transform `logit` is read as `ln(p / (1 − p))`, with `p` kept between 1e-6 and 1 − 1e-6; `identity`, the default, reads it as it is.
- **A missing value** takes its `fill`, before the transform. With no fill, it adds nothing.
- **Kairos checks the samples** as for XGBoost: each must score within 1e-6 of what you give.
- A score step uses it as any scoring model: `{ "type": "score", "model": "loan-stacked@1", "features": { "xgb": "{{ steps.xgb.output.score }}", "hardship": "{{ steps.ask.output.hardship.probability }}" } }`.

## Versions, the latest, and archive

- `loan-default@2` is that version, until you change the step. `loan-default` is the latest version when the step runs, so its scores change when someone uploads a new one. The console offers both, and warns about the second.
- **Archive** on the model's page stops new workflows from using it. Kairos refuses to archive a model that a published workflow uses, and names the workflow. An archived model still scores in the workflows that use it.
- **Download** gives the model's JSON. XGBoost's `Booster.load_model` reads it.

## From the command line

```bash
kairos models list --kind scoring --q loan
kairos models get loan-default@2
kairos models upload loan-default --upload loan-default/upload.json
kairos models upload loan-default --file model.json --samples samples.json --name "Loan default"
kairos models score loan-default@2 -f hardship=0.8 -f amount=6000
kairos models promote loan-default@2 --to production
```

With no version, `score` and `promote` use the latest one. `upload` sends the file with gzip.

## Limits

| | |
|---|---|
| Upload | 4 MB with gzip, 64 MB without |
| Trees | 5,000, each at most 32 deep |
| Features | 500 |
| Sample rows | 100 to 1,000 |
| Training rows in one export | 200,000 |

A model of 1,000 trees of depth 6 is about 5 MB of JSON and 1.4 MB with gzip. A score of 1,000 trees of depth 8 takes less than 0.1 ms.

## What to know first

- **A scoring model needs labels.** The insurance test had 1,782 claims. With a few dozen positives, train later, or use Grayson alone.
- **Entity properties are today's.** A decision as of a past moment reads an entity's properties as they are now. A property set because of the fraud can thus get into the training rows. Train on history whose properties did not change after the fact, or leave those properties out of the sandbox.
- **A missing value is not an error.** A feature that a run cannot read, such as the output of a step that did not run on its path, is missing. XGBoost sends it down its default branch, and the decision lists it.
- **The gains can be small.** In Finic's tests, Grayson's answers added 0.007 to 0.008 of ROC-AUC. Measure the gain on your own data with `compare_without` before you use the model.

Next: [Workflows](workflows.md#score-with-a-model) for the step, and the [API reference](../reference/api.md#models).
