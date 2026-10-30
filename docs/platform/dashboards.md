# Dashboards and metrics

A dashboard is a page of tiles that you build yourself. This page says what a tile can ask. The request behind it is [`POST /v1/metrics/query`](../reference/api.md#post-v1metricsquery).

A tile asks one question with fixed choices, not a query language:

| Part | Choices |
|---|---|
| Data | Decisions, events, labels |
| Measure | Count; unique subjects or entities; share of decisions with an outcome (block rate); average or sum of a number (risk score, a numeric event property) |
| Filters | Decisions: action, outcome, final outcome, signal, and whether the subject carries a label. Events: type, a property value, an entity type. Labels: label, entity type. |
| Group by | Outcome, final outcome, action, signal, typology, subject type, event type, an event property, label, entity type |
| Show as | Number (with the change from the period before), line, area, bars, stacked bars, ranked bars, table |

A decision metric can also be grouped by risk score band, and an outcome filter or share can name several outcomes (`review,block`). The "list" view shows the most recent decisions that match a tile's action and outcome, not a number.

The period (24 hours, 7, 30 or 90 days) is set once for a dashboard. Times are UTC, and a week starts on Monday.

Two filters use the labels to measure the decisions themselves: "approved, and the subject carries a label" counts likely misses, and "blocked, and the subject has no label" counts possible false positives. They use every label of the subject, at any date.

A metric is computed from the stored rows at request time. One tile reads at most 250,000 rows of its period; past that the result is marked `truncated` and is a lower bound. More than eight groups are shown as eight and "Other" for a count; for other measures only the eight largest are shown.
