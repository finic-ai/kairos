# Templates

Kairos accepts any event and any action, so nothing here is required. These are starting points for you to copy and change; measured results are listed below where available.

There are three kinds:

- **[Action templates](#action-templates)**: complete action definitions. This is the part that is hard to write well, and the part worth copying.
- **[Event shapes](#event-shapes)**: recommended names and fields for common events, each with a schema and an example.
- **Webhook presets**: mappings for providers that send inbound webhooks, offered in **Settings › Webhooks**. See [Inbound webhooks](../platform/webhooks/inbound.md#templates).

> **Read this first.** Every template was written for synthetic data, by the same people who wrote the scenarios. The measured results below apply only to those cases. The ticketing and ecommerce templates have no measured model results yet. Use a template as a first draft, then [backtest](../reference/clients/typescript.md#backtesting) and set the thresholds on your own outcomes.

## Action templates

The console offers each template when you make an action, and [`GET /v1/templates`](../reference/api.md#get-v1templates) returns them all.

| Template | Decides | Subject |
|---|---|---|
| `withdrawal` | Release or hold a crypto withdrawal | user |
| `bank_transfer` | Release or hold an outbound bank transfer | user |
| `merchant_onboarding` | Approve a merchant application | merchant |
| `fraud_claim` | Pay or hold a customer's fraud claim | user |
| `red_flag` | Confirm or clear a suspected red flag | user |
| `atm_withdrawal` | Release or hold a cash withdrawal | user |
| `loan_application` | Send a loan application on to underwriting, or hold it for fraud | user |
| `insurance_claim` | Pay a motor insurance claim automatically, or hold it | policyholder |
| `medical_claim` | Pay a provider's health claim, or hold it for pre-payment review | provider |
| `push_payment` | Release a payment, or hold it because the customer may be sending it to a scammer | user |
| `ticket_purchase` | Approve an event ticket purchase, or hold it for automation, limit evasion or takeover | user |
| `ecommerce_checkout` | Approve a shop order, or hold it for card testing, stolen payment details or takeover | user |

### Ticketing and ecommerce

These two have no measured results yet. In an integration, use stable tokens for payment methods and delivery addresses, so that the same method or address links its customers. Performances and product SKUs are ordinary properties, so customers who buy the same item do not become linked. The ecommerce action also counts declined payments and sums their amounts within the current session.

Inventory, queue validation, hard purchase limits, payment authorisation and fulfilment stay in your application. The ticketing model's inference about coordinated accounts is not an atomic limit check. Adapt the event names, questions and thresholds before you evaluate them on your own outcomes.

### Use one

In the console, open **Actions**, then **New action**, and choose **Start from a template**. Choose a template, then **Use template**: it fills in the question, the signals, the typologies and the policy. **Use a template** at the top of the page opens the list again. Change what you need, give it a name, and create it. If the name is already taken the page says so, because creating it would save a new version of that action.

With the API, read a template and send everything but its `name`:

```ts
const response = await fetch("https://kairos.finic.ai/v1/templates", {
  headers: { Authorization: `Bearer ${process.env.KAIROS_API_KEY}` },
});
const { templates } = await response.json();
const { name, ...definition } = templates.find((t: { name: string }) => t.name === "fraud_claim");
await kairos.defineAction(name, definition);
```

### What each one was tested on

All numbers are from synthetic cases. "Held" means review or block. Results moved by a case or two between runs, so a range is given where that happened.

**`withdrawal`** — 100 cases, 10 of each of 10 kinds.

| | Result |
|---|---|
| Fraud not approved | 56 of 60 |
| Honest customers not approved | 11 of 40, all stepped up by the policy rule, none held |
| Weakest case | Hard takeovers: 6 of 10 held |

The template declares one total: bank deposits for 7 days, against a usual week, and the share of the withdrawal they cover. It names the event `deposit_bank` and the amount `usd`, as the evaluation data does. Change both to your own names, or the total is always zero. Without the total the same suite gave 52 of 60 and 10 of 40.

**`bank_transfer`** — 2 hand-written cases, so this shows only that it runs. An established customer paying rent was approved at 0; a two-day-old account on a device shared with flagged users was blocked at 96 or above. Starts on the event `bank_transfer_requested`.

**`merchant_onboarding`** — 34 applications of six kinds.

| | Result |
|---|---|
| Bad applications not approved | 16 or 17 of 18 |
| Honest applications not approved | 0 of 16, including an accountant onboarding clients from one office |
| Weakest case | Stolen business identity: 2 or 3 of 4 |

**`fraud_claim`** — 34 claims of seven kinds. "Approve" means pay the claim automatically.

| | Result |
|---|---|
| Real claims paid | 14 or 15 of 15 |
| First-party fraud and claim abuse held | 15 of 15 |
| Scam victims, where the customer made the payment | 4 of 4 held for a person to decide |
| Note | The score alone does not separate first-party fraud from real card theft. The policy rules do that work, and they were tuned on these cases. |

**`red_flag`** — 12 red flags of four kinds. Takeovers and card testing were confirmed; a travelling customer and a house purchase were cleared: 12 of 12. Both honest kinds were cleared because of a message the customer had sent earlier.

**`atm_withdrawal`** — 28 withdrawals of six kinds. No policy rules.

| | Result |
|---|---|
| Mules at an ATM where earlier mules were confirmed | 4 to 6 of 6 |
| Mules at an ATM with no labels yet | 0 or 1 of 6 |
| Honest customers at the same ATMs | 0 of 16 held |
| Note | Depends on links through the ATM. With the ATM left out of `linkTypes`, 0 or 1 of 6. |

**`loan_application`** — 26 applications of six kinds. It decides fraud only: whether the applicant can afford the loan stays in your underwriting, with its own rules on adverse action notices.

| | Result |
|---|---|
| Synthetic identities, stolen identities and loan stacking not approved | 13 of 13 in two runs |
| Honest applicants not approved | 0 of 13 in two runs, including a student with one card and an immigrant whose SSN is one year old |
| Note | Without the visit, loan stacking scores under 0.5 and only the rule `stacking_on_overstated_income` holds it. With the visit, where the applicant raises the income after seeing the limit, it scores 0.51 to 0.75. See [Visits and sessions](#visits-and-sessions). |

The SSN is an entity, so send a token for it, never the number. In the first run, a device id from another example in the same account carried a `fraud_victim` label, and the model read it as a link to fraud. Keep ids of test data apart from real ids.

**`insurance_claim`** — 25 motor claims of five kinds. "Approve" means pay the claim automatically. The subject is the policyholder.

| | Result |
|---|---|
| Staged, inflated and pre-existing losses not paid automatically | 11 of 13 before the last rule, 13 of 13 after it |
| Honest claims not paid automatically | 0 of 12, including a claim three weeks into a new policy, a second hail claim, and a report delayed by a stay in hospital |
| Note | Without the visit, cover upgraded days before a "loss" scored under 0.5 and was called legitimate; the rule `upgraded_for_old_damage` holds it. With the visit that bought the cover and looked up how to claim, all four pre-existing losses were called by their name. |

The repair shop is not in `linkTypes`. With it, the model marked a busy honest shop as a link to fraud claims, with no fraud label on any claim at that shop. The ring is still found through the other driver, the clinic and the lawyer.

**`medical_claim`** — 24 claims from providers of seven kinds. "Approve" means pay. The subject is the provider, not the patient. It judges fraud, waste and abuse, not whether the care was clinically right.

| | Result |
|---|---|
| Phantom billing, upcoding, kickback schemes and excluded providers held | 12 of 12 in two runs with different data |
| Honest providers held | 0 of 12 in the same two runs, including an oncologist whose visits are mostly the highest level, an urgent care clinician in a flu outbreak, a provider enrolled three weeks ago, and a practice whose patients' ids a phantom clinic billed before |
| Note | Without portal visits, upcoding scores 0.35 to 0.48 and is held by the rule `high_levels_for_simple_care`. With them, where denied claims are resubmitted at a higher level, it scores 0.79 to 0.86. A provider that returns with the owner, the bank account or the portal computer of an excluded one scores under 0.2 either way, and is held only by the rule `linked_to_excluded`. |

The template has two exact totals: minutes billed in the last 24 hours, and money billed in a week against a usual week. The rule `more_than_a_day_billed` holds a provider that billed more than 1,440 minutes in 24 hours, whatever the model says. Send the minutes that each code stands for, and give each provider its peer figures as properties (the share of highest-level visits for its specialty), or the model cannot compare.

The lab is not in `linkTypes`. With it, the model read a large lab as a link to an excluded provider, although the share of excluded providers at that lab was below normal. Patients are links: send a token for each member, never a name or a date of birth. Health claims carry protected health information, so run the server and the model calls under the agreements that the law requires.

**`push_payment`** — 32 payments of thirteen kinds: authorised push payment scams (pig butchering, romance, impersonation, purchase, invoice redirection), account takeover for the contrast (one of them through a data aggregator), and six kinds of honest payment. "Approve" means release. The customer is real and means to send the money, so the device and the password show nothing; the history of the last weeks and the visit do.

| | Result |
|---|---|
| Scam and takeover payments held | 16 of 16 in two runs with the visits |
| Honest payments held | 0 of 16 in the same runs, including a house deposit after moving in savings and raising the limit, two years of monthly buys at a large crypto exchange, a budgeting app that reads the account through Plaid, and brokerage deposits that Plaid starts |
| Note | Invoice redirection and the takeover through the aggregator are held for review, not always blocked. Typologies were right 32 of 32. |

The rule on a reported payee needs a new payee too (`new_payee_reported`). With the rule on `payee_reported` alone, the honest crypto investors were held: one earlier scam victim among the exchange's many customers was enough for the model to report the reason. The romance scams were called legitimate at first, because the customer answered "Yes" to "Have you met this person?". With an earlier visit where the same customer answered "Not yet, we met online", and the reason `answer_changed`, both were held.

A data aggregator such as Plaid signs in to the accounts of many customers from the same servers. If you send those sign-ins as a `device`, that device links every customer who linked an app, earlier scam and takeover victims among them. In the first run, the three honest customers whose budgeting app reads the account through Plaid were all held (risk 32 to 69): the summary showed 22 other users on the device, 5 of them scam victims, at a share of 0.23 against a normal share of 0.02. Describing the device as Plaid's servers, and saying in the template that such a device is not a sign of fraud, did not help: risk went up to 79. What worked was to send the aggregator as its own entity type, `aggregator`, defined with `link: false` and not in `linkTypes`. The example does this, and then 0 of 6 aggregator customers were held, while the takeover in which the thief linked a new app through the aggregator after a password reset was still held. The sign-ins stay in the history, so the model still sees which app read the account and when.

### Visits and sessions

The loan, insurance, medical and scam payment tests send the visit in which each application, claim or payment is made, with `$session` on its events: pages, the calculator, help chats, sign-ins, pasted fields, eligibility checks, uploads, resubmissions. The visit is different for each kind of fraud, and it is written for each kind:

| Example | Kind | The visit |
|---|---|---|
| Loans | honest | Arrives from somewhere, reads the rates, tries the calculator, corrects a typo |
| Loans | synthetic identity | Straight to the form, fields pasted, sometimes an automation tool; one visit applies for two people |
| Loans | stolen identity | A browser that claims to be another, or a password reset and new contact details first |
| Loans | loan stacking | From a comparison site; raises the income after seeing the limit |
| Insurance | honest | Own phone, photos taken in the app, then picks a repair shop |
| Insurance | staged accident | A claim runner signs in to several policyholders' accounts from one office computer in one visit and pastes the story |
| Insurance | inflated | Reads what the policy pays for injuries and repairs first |
| Insurance | pre-existing loss | The visit that bought the cover looked up how to claim; photos come from the gallery |
| Medical | honest | The office computer, eligibility checks, claims typed in |
| Medical | phantom billing | A new device on a VPN, the payment account changed, a batch of claims with no eligibility checks |
| Medical | upcoding | Denied claims resubmitted one level higher |
| Medical | kickback scheme | Referrals from one doctor, then claims copied within minutes, from a computer the ring's clinics share |
| Medical | excluded provider | The excluded provider's portal computer comes back |
| Payments | honest | The usual phone, an existing payee, or a new payee typed in and checked |
| Payments | pig butchering | Weeks of visits that switch to another app and come back; details pasted; savings moved in and the limit raised; "No" to the warning about online contacts after a long minute on it |
| Payments | romance scam | Long switches to another app; "Not yet, we met online" to a warning in an earlier visit, "Yes" now |
| Payments | impersonation scam | A phone call active through the visit, sometimes a remote access app; savings moved in; the name check warning accepted |
| Payments | purchase scam | Details pasted from another app; "No, I saw it on a marketplace" |
| Payments | invoice redirection | Details pasted; the name check shows another company's name and is accepted |
| Payments | account takeover | A password reset, a sign-in from a new device abroad and a new email in the same visit |
| Payments | takeover through an aggregator | The same, then a new app linked through the aggregator pulls the money out |
| Payments | honest, through an aggregator | A budgeting app reads the account every few days; a brokerage app starts the customer's usual deposits |

Each example was run twice on the same cases, once with the visits and once without them (no visit events and no `$session`). One run each:

| | Without the visit | With the visit |
|---|---|---|
| Loans: stolen identity | mean risk 56, none blocked | mean risk 86, 2 of 4 blocked |
| Loans: loan stacking | mean risk 31, held by a rule | mean risk 66 |
| Insurance: pre-existing loss | 2 of 4 paid automatically | 0 of 4 |
| Medical: upcoding | mean risk 42, held by a rule | mean risk 79 |
| Medical: kickback scheme | mean risk 84, none blocked | mean risk 93, 2 of 3 blocked |
| Medical: excluded provider | 1 of 3 paid | 0 of 3: the portal computer is a link |
| Payments: scams and takeovers held | 6 of 15 | 15 of 15 |
| Honest cases held | 0 of 47 | 0 of 47 |

Kinds that were already clear without the visit (synthetic identities, staged accidents, phantom billing, all at 96 or above) did not change. For payments, pig butchering was held either way, from the weeks of growing payments; romance, impersonation, purchase and invoice scams mostly were not. The takeovers without the visit also lost their password reset and new device, which were visit events, so that row shows missing events more than a missing session. The visits were written together with the cases, so this shows where a visit can help, not how much it will help on your data.

What helped was the events of the visit, not the grouping alone. Deciding the same loan applications with and without `$session`, with the visit events stored either way, gave nearly the same answers: for a new applicant, almost every event is already the visit. The grouping matters more for a customer with a long history.

Two reasons had to be narrowed after the first run. `filed_by_someone_else` was reported for honest claims that shared a busy clinic, until its description said that a shared clinic is not this. `weekend_or_night_services` was reported for every honest provider whose claim was sent in the evening, until the claims carried a service time and the description said that the time of sending does not count.

### Adapting a template

In rough order of how much it matters:

1. **Rewrite the reason descriptions in your own vocabulary.** The model reads the description, not the code. "The withdrawal goes to a destination address that was added recently" only works if your events say when an address was added.
2. **Check that your events carry what each reason needs.** A reason about a new device needs events that name a device. A reason about a message needs the message text.
3. **Remove what you cannot observe.** A reason that can never be true is noise.
4. **Give shared services their own entity type.** A data aggregator such as Plaid, a payment processor, a corporate VPN or a shared office computer at a billing company can sign in for many unrelated customers. Sent as a `device` or an `ip`, it links all of them, and labels on a few of them become a false link reason. Send it under a type such as `aggregator`, define that type with `link: false`, and keep it out of `linkTypes`. Telling the model in the template text was not enough in testing.
5. **Set `review` and `block` from a backtest.** The thresholds in the templates are 0.5 and 0.9 (`bank_transfer` blocks at 0.95; `atm_withdrawal` sets none and gets these defaults), and hard cases often score well under 0.5.
6. **Treat the policy rules as hypotheses.** Each was added after looking at the cases it now catches. Keep a rule only if it holds on your data.
7. **Keep the "nothing wrong" typology.** Without one, the model must choose a bad explanation for a good customer.

Changing the wording creates a new version of the action. Compare versions on the same cases before you switch.

## Event shapes

Each event has its own page in [Event templates](events/README.md), with its field table, its example, and its stages if it is a record.

| Event | What it is |
|---|---|
| [`login`](events/login.md), [`login_failed`](events/login_failed.md) | A sign-in and a failed attempt |
| [`password_reset`](events/password_reset.md), [`contact_changed`](events/contact_changed.md) | Credential and contact changes |
| [`account_opened`](events/account_opened.md) | A new account |
| [`beneficiary_added`](events/beneficiary_added.md) | A payee, a beneficiary or a withdrawal address was added |
| [`transaction`](events/transaction.md) | Money moved: a record with stages |
| [`support_message`](events/support_message.md) | Something the customer wrote |
| [`application_submitted`](events/application_submitted.md) | A completed application |
| [`bank_transfer_requested`](events/bank_transfer_requested.md) | A request that starts a decision |
| [`fraud_claim`](events/fraud_claim.md) | A claim: a record with stages |

A template is documentation. The server does not check an event against it, and an event that follows none of them is accepted in the same way.

The rest of this section explains the choices behind the shapes.

Use any event type and any field names: in testing, the model read differently named events in four domains without trouble, and adding structure for its own sake did not improve decisions. What these shapes are for is making sure you send the three things that are easy to leave out:

- **entities**, so that history and links exist
- **`universalId` and `status`**, for anything that changes over time
- **free text**, which decided more cases than any other single thing

### Login

```ts
kairos.track("login", { userId, deviceId, ipId: "203.0.113.7", ip_country: "GB", ip_city: "Leeds", method: "password" });
kairos.track("login_failed", { userId, deviceId, ipId: "203.0.113.7" });
```

Name the device and the IP address as entities. A new device is visible only against a history of logins that name the usual one.

### Credential and contact changes

```ts
kairos.track("password_reset", { userId, ipId, ip_country: "RO" });
kairos.track("contact_changed", { userId, deviceId, what: "phone" });
kairos.track("two_factor_disabled", { userId, deviceId });
```

One event type per kind of credential change reads better than one `credentials_updated` with a field. These events are rare, so they are kept in full however old they are.

### Money movement

```ts
kairos.track("transaction", {
  userId,
  universalId: "txn_8812",   // the same id for every stage of this transaction
  status: "pending",
  direction: "out",
  amount: 500,
  currency: "USD",
  payeeId: "payee_31",        // the other side, as an entity
  channel: "card_present",
  memo: "rent",
});
kairos.track("transaction", { userId, universalId: "txn_8812", status: "completed" });
```

Send the counterparty as an entity: a payee, a merchant, a destination address. That is what lets two customers who pay the same mule be linked. Use `universalId` so that pending and completed are one transaction; see [Records that change](../reference/clients/typescript.md#records-that-change).

### Account and application events

```ts
kairos.track("account_opened", { userId, deviceId, ipId, channel: "mobile_app" });
kairos.track("beneficiary_added", { userId, beneficiaryId });
kairos.track("beneficiary_added", { userId, destinationId, label: "my ledger" });
kairos.track("application_submitted", { merchantId, deviceId, ipId, minutes_to_complete: 4, pasted_fields: 11 });
```

"Added" events matter because "added recently" is one of the most useful signals, and it needs a date.

### Messages and notes

```ts
kairos.track("support_message", { userId, text: "I am flying to Lisbon on Friday for two weeks. Will my card work there?" });
kairos.track("website_reviewed", { merchantId, websiteId, text: "Checkout redirects to a different domain that sells casino credits." });
```

Send the text as it is. Do not summarise it or reduce it to a category.

### Requests

The thing you want decided, sent with [`trackAndDecide`](../reference/clients/typescript.md#decide-from-an-event):

```ts
const decision = await kairos.trackAndDecide("bank_transfer_requested", { userId, beneficiaryId, deviceId, amount: 9500, currency: "USD" });
```

### Outcomes

What you found out later. Close the record with a status, and put a label on whatever the outcome is about:

```ts
kairos.track("fraud_claim", { userId, universalId: "claim_0300", status: "ACCOUNT_ABUSE" });
await kairos.label({ type: "user", id: userId }, "account_abuse");
```

See [Labels](../reference/clients/typescript.md#labels) for where a label belongs.

### Naming

- Event types: lower case with underscores, past tense for things that happened (`password_reset`, `beneficiary_added`), `_requested` for requests.
- Amounts: one unit throughout. Do not mix cents and whole units across event types.
- Keep a name once you have chosen it. A renamed event type is a new event type, with no history.
